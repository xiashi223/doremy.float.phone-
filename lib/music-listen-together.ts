// lib/music-listen-together.ts
// 音乐一起听核心模块：prompt 组装、LLM 调用（点评/切歌决策）、弹幕历史、情绪记忆、防复读、出口清洗、会话持久化。

import { simpleLLMCall } from "./api-helpers";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { MusicTrack } from "./music-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import { renderUserNameMacro } from "./user-macro";

// ── Storage Keys ──
export const LISTEN_HISTORY_KEY = "music-listen-together-v1";
export const LISTEN_MOOD_KEY = "music-listen-together-mood-v1";
export const LISTEN_SESSION_KEY = "music-listen-together-session-v1";
export const LISTEN_SELECTED_KEY = "music-listen-together-selected-v1";

registerKvMigration(LISTEN_HISTORY_KEY);
registerKvMigration(LISTEN_MOOD_KEY);
registerKvMigration(LISTEN_SESSION_KEY);
registerKvMigration(LISTEN_SELECTED_KEY);

export const LISTEN_SESSION_EVENT = "music-listen-together-session-changed";

// ── Constants ──
export const BUBBLE_MAX_CHARS = 80;
const MAX_HISTORY_TRACKS = 30;
const MAX_COMMENTS_PER_TRACK = 50;
const MAX_MOOD_RECORDS = 300;
const PERSONA_CHAR_BUDGET = 1200;
const LYRIC_BRIEF_CHARS = 240;

// ── Types ──
export type ListenCommentEntry = {
    id: string;
    trackId: string;
    characterId: string;
    characterName: string;
    text: string;
    createdAt: number;
    kind?: "comment" | "skip-mutter" | "skip-propose";
};

export type ListenTrackHistory = {
    trackId: string;
    title: string;
    artist: string;
    updatedAt: number;
    comments: ListenCommentEntry[];
};

export type ListenMoodRecord = {
    key: string; // `${characterId}::${trackId}`
    characterId: string;
    trackId: string;
    trackTitle: string;
    listenCount: number;
    recentComments: string[]; // 最近两句点评
    skipWantedCount: number;
    skipDeniedCount: number;
    updatedAt: number;
};

export type ListenTogetherSession = {
    active: boolean;
    characterIds: string[];
    intervalMin: number; // 秒
    intervalMax: number; // 秒
    startedAt: number;
};

export type ListenSkipDecision = {
    characterId: string;
    characterName: string;
    wantSkip: boolean;
    reason: string; // 清洗后的短弹幕理由
};

export type PreviousSkipTransition = {
    fromTitle: string;
    fromArtist: string;
    proposerId?: string;
    proposerName?: string;
    reason?: string;
    at: number;
};

// ── JSON Helpers ──
function readKvJson<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    const raw = kvGet(key);
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function writeKvJson(key: string, value: unknown): void {
    if (typeof window === "undefined") return;
    kvSet(key, JSON.stringify(value));
}

// ── Session & Selection Persistence ──
const DEFAULT_SESSION: ListenTogetherSession = {
    active: false,
    characterIds: [],
    intervalMin: 18,
    intervalMax: 32,
    startedAt: 0,
};

export function loadListenSelectedIds(): string[] {
    const raw = readKvJson<string[]>(LISTEN_SELECTED_KEY, []);
    if (!Array.isArray(raw)) return [];
    const validIds = new Set(loadCharacters().map((c) => c.id));
    return raw.filter((id) => typeof id === "string" && validIds.has(id));
}

export function saveListenSelectedIds(ids: string[]): void {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    writeKvJson(LISTEN_SELECTED_KEY, unique);
}

export function loadListenSession(): ListenTogetherSession {
    const stored = readKvJson<Partial<ListenTogetherSession>>(LISTEN_SESSION_KEY, DEFAULT_SESSION);
    const validIds = new Set(loadCharacters().map((c) => c.id));
    const characterIds = Array.isArray(stored.characterIds)
        ? stored.characterIds.filter((id): id is string => typeof id === "string" && validIds.has(id))
        : [];
    const intervalMin = typeof stored.intervalMin === "number" ? Math.max(8, Math.min(120, Math.round(stored.intervalMin))) : 18;
    const intervalMax = typeof stored.intervalMax === "number" ? Math.max(intervalMin + 4, Math.min(180, Math.round(stored.intervalMax))) : Math.max(intervalMin + 8, 32);
    const active = Boolean(stored.active) && characterIds.length > 0;
    return {
        active,
        characterIds,
        intervalMin,
        intervalMax,
        startedAt: typeof stored.startedAt === "number" ? stored.startedAt : 0,
    };
}

export function saveListenSession(session: ListenTogetherSession): void {
    writeKvJson(LISTEN_SESSION_KEY, session);
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(LISTEN_SESSION_EVENT, { detail: session }));
    }
}

export function startListenSession(characterIds: string[], intervalMin = 18, intervalMax = 32): ListenTogetherSession {
    const cleanIds = Array.from(new Set(characterIds.filter(Boolean)));
    saveListenSelectedIds(cleanIds);
    const next: ListenTogetherSession = {
        active: cleanIds.length > 0,
        characterIds: cleanIds,
        intervalMin: Math.max(8, Math.min(120, Math.round(intervalMin))),
        intervalMax: Math.max(Math.max(8, Math.round(intervalMin)) + 4, Math.min(180, Math.round(intervalMax))),
        startedAt: Date.now(),
    };
    saveListenSession(next);
    return next;
}

export function stopListenSession(): ListenTogetherSession {
    const current = loadListenSession();
    const next: ListenTogetherSession = {
        ...current,
        active: false,
    };
    saveListenSession(next);
    return next;
}

// ── Danmaku History Persistence ──
export function loadAllListenHistory(): ListenTrackHistory[] {
    const list = readKvJson<ListenTrackHistory[]>(LISTEN_HISTORY_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item.trackId === "string" && Array.isArray(item.comments));
}

export function getTrackListenHistory(trackId: string): ListenCommentEntry[] {
    if (!trackId) return [];
    const found = loadAllListenHistory().find((item) => item.trackId === trackId);
    return found ? found.comments : [];
}

export function appendListenHistory(
    track: Pick<MusicTrack, "id" | "title" | "artist">,
    entry: Omit<ListenCommentEntry, "id" | "trackId" | "createdAt"> & { id?: string; createdAt?: number },
): ListenCommentEntry {
    const list = loadAllListenHistory();
    const now = entry.createdAt ?? Date.now();
    const fullEntry: ListenCommentEntry = {
        id: entry.id || `lt_${now}_${Math.random().toString(36).slice(2, 7)}`,
        trackId: track.id,
        characterId: entry.characterId,
        characterName: entry.characterName,
        text: entry.text,
        createdAt: now,
        kind: entry.kind ?? "comment",
    };
    const idx = list.findIndex((item) => item.trackId === track.id);
    if (idx >= 0) {
        const existing = list[idx];
        const comments = [...existing.comments, fullEntry].slice(-MAX_COMMENTS_PER_TRACK);
        list[idx] = {
            ...existing,
            title: track.title || existing.title,
            artist: track.artist || existing.artist,
            updatedAt: now,
            comments,
        };
    } else {
        list.push({
            trackId: track.id,
            title: track.title,
            artist: track.artist,
            updatedAt: now,
            comments: [fullEntry],
        });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    writeKvJson(LISTEN_HISTORY_KEY, list.slice(0, MAX_HISTORY_TRACKS));
    return fullEntry;
}

// ── Mood Memory Persistence (Observable Signals Only) ──
function moodKey(characterId: string, trackId: string): string {
    return `${characterId}::${trackId}`;
}

export function loadAllListenMoods(): ListenMoodRecord[] {
    const list = readKvJson<ListenMoodRecord[]>(LISTEN_MOOD_KEY, []);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item.key === "string");
}

export function getListenMood(characterId: string, trackId: string): ListenMoodRecord | null {
    const key = moodKey(characterId, trackId);
    return loadAllListenMoods().find((item) => item.key === key) ?? null;
}

function upsertListenMood(
    characterId: string,
    track: Pick<MusicTrack, "id" | "title">,
    updater: (prev: ListenMoodRecord) => ListenMoodRecord,
): ListenMoodRecord {
    const list = loadAllListenMoods();
    const key = moodKey(characterId, track.id);
    const idx = list.findIndex((item) => item.key === key);
    const base: ListenMoodRecord = idx >= 0
        ? list[idx]
        : {
            key,
            characterId,
            trackId: track.id,
            trackTitle: track.title,
            listenCount: 0,
            recentComments: [],
            skipWantedCount: 0,
            skipDeniedCount: 0,
            updatedAt: Date.now(),
        };
    const updated = {
        ...updater(base),
        trackTitle: track.title || base.trackTitle,
        updatedAt: Date.now(),
    };
    if (idx >= 0) list[idx] = updated;
    else list.push(updated);
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    writeKvJson(LISTEN_MOOD_KEY, list.slice(0, MAX_MOOD_RECORDS));
    return updated;
}

export function recordTrackListenExposure(characterIds: string[], track: Pick<MusicTrack, "id" | "title">): void {
    if (!track.id || characterIds.length === 0) return;
    for (const characterId of characterIds) {
        upsertListenMood(characterId, track, (prev) => ({
            ...prev,
            listenCount: prev.listenCount + 1,
        }));
    }
}

export function recordMoodComment(characterId: string, track: Pick<MusicTrack, "id" | "title">, comment: string): void {
    upsertListenMood(characterId, track, (prev) => ({
        ...prev,
        listenCount: Math.max(1, prev.listenCount),
        recentComments: [...prev.recentComments, comment].slice(-2),
    }));
}

export function markSkipWanted(characterId: string, track: Pick<MusicTrack, "id" | "title">): void {
    upsertListenMood(characterId, track, (prev) => ({
        ...prev,
        listenCount: Math.max(1, prev.listenCount),
        skipWantedCount: prev.skipWantedCount + 1,
    }));
}

export function markSkipDenied(characterIds: string[], track: Pick<MusicTrack, "id" | "title">): void {
    for (const characterId of characterIds) {
        upsertListenMood(characterId, track, (prev) => ({
            ...prev,
            listenCount: Math.max(1, prev.listenCount),
            skipDeniedCount: prev.skipDeniedCount + 1,
        }));
    }
}

// ── Invariant 1: LLM Channel Resolution (No Chat Preset Pollution) ──
export function resolveCharacterApiConfig(characterId: string): ApiConfig | null {
    const bindingConfig = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    if (apiConfigs.length === 0) return null;

    const chatSlot = resolveBinding(bindingConfig, characterId, "chat");
    if (chatSlot.apiConfigId) {
        const found = apiConfigs.find((c) => c.id === chatSlot.apiConfigId);
        if (found) return found;
    }
    const defaultSlot = resolveBinding(bindingConfig, characterId);
    if (defaultSlot.apiConfigId) {
        const found = apiConfigs.find((c) => c.id === defaultSlot.apiConfigId);
        if (found) return found;
    }
    return apiConfigs[0] ?? null;
}

// ── Invariant 2 & 3: Context Chain & Zero Hardcoded Address ──
export function resolveUserLabel(characterId: string): string {
    const identity = resolveUserIdentity(characterId, "chat") ?? resolveUserIdentity(characterId);
    const name = identity?.name?.trim();
    return name || "身边的人";
}

const SPEECH_STYLE_SECTION_RE = /(说话风格|语气|口吻|语言风格|对话风格|台词|口癖|句式|称呼|语调|speech|tone|style|voice|mannerism)/i;

/**
 * 裁剪 persona 到 1200 字预算，强制优先保留「说话风格/口吻/台词」类小节，防止退化成客服腔。
 */
export function trimPersona(rawPersona: string, budget = PERSONA_CHAR_BUDGET): string {
    const cleaned = String(rawPersona ?? "").trim();
    if (!cleaned) return "";
    if (cleaned.length <= budget) return cleaned;

    const blocks = cleaned.split(/\n{2,}|(?=^#{1,4}\s|^【[^】]+】|^\[[^\]]+\])/m).map((b) => b.trim()).filter(Boolean);
    if (blocks.length <= 1) {
        return `${cleaned.slice(0, budget)}…`;
    }

    const styleBlocks: string[] = [];
    const otherBlocks: string[] = [];
    for (const block of blocks) {
        const headLine = block.split("\n", 1)[0] || "";
        if (SPEECH_STYLE_SECTION_RE.test(headLine) || SPEECH_STYLE_SECTION_RE.test(block.slice(0, 80))) {
            styleBlocks.push(block);
        } else {
            otherBlocks.push(block);
        }
    }

    const picked: string[] = [];
    let used = 0;

    for (const block of styleBlocks) {
        if (used + block.length + 2 <= budget) {
            picked.push(block);
            used += block.length + 2;
        } else if (used < budget * 0.65) {
            const remain = Math.max(120, budget - used);
            picked.push(`${block.slice(0, remain)}…`);
            used = budget;
            break;
        }
    }

    const orderedResult: string[] = [];
    const styleSet = new Set(styleBlocks);
    let otherBudget = Math.max(0, budget - used);

    for (const block of blocks) {
        if (styleSet.has(block)) {
            const match = picked.find((p) => p === block || p.startsWith(block.slice(0, 40)));
            if (match) orderedResult.push(match);
        } else if (otherBudget > 40) {
            if (block.length + 2 <= otherBudget) {
                orderedResult.push(block);
                otherBudget -= block.length + 2;
            } else {
                orderedResult.push(`${block.slice(0, otherBudget)}…`);
                otherBudget = 0;
            }
        }
    }

    return orderedResult.join("\n\n").slice(0, budget + 20);
}

export function stripLrcTimestamps(rawLyrics?: string): string {
    if (!rawLyrics) return "";
    return rawLyrics
        .split(/\r?\n/)
        .map((line) => line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim())
        .filter((line) => line && !/^\[(ti|ar|al|by|offset):/i.test(line) && !/^(作词|作曲|编曲|制作人|混音|吉他|贝斯|鼓|和声)\s*[:：]/i.test(line))
        .join(" / ");
}

export function analyzeLyricMood(track: Pick<MusicTrack, "title" | "artist" | "lyrics">): string {
    const sample = `${track.title} ${ stripLrcTimestamps(track.lyrics).slice(0, 400) }`.toLowerCase();
    const tags: string[] = [];
    if (/泪|哭|痛|遗憾|分开|告别|思念|孤单|寂寞|冷|碎|失落|难过|sad|tears|lonely|goodbye/.test(sample)) {
        tags.push("伤感/思念");
    }
    if (/甜|笑|喜欢|心动|温柔|晴|风|拥抱|暖|星|梦|吻|sweet|love|warm|smile/.test(sample)) {
        tags.push("温柔/治愈");
    }
    if (/燃|火|战|光|冲|狂|破|自由|奔跑|摇滚|燥|fire|fight|run|wild/.test(sample)) {
        tags.push("热血/高能");
    }
    if (/夜|月|酒|灯|街|雨|影子|凌晨|晚风|night|moon|rain|midnight/.test(sample)) {
        tags.push("夜晚/氛围");
    }
    if (/舞|派对|快乐|跳|节拍|夏日|汽水|party|dance|summer|beat/.test(sample)) {
        tags.push("轻快/律动");
    }
    return tags.length > 0 ? tags.join("、") : "日常/随性聆听";
}

export function buildTrackBrief(track: MusicTrack, currentTimeSec = 0, currentLyricLine = ""): string {
    const stripped = stripLrcTimestamps(track.lyrics);
    const lyricExcerpt = stripped ? stripped.slice(0, LYRIC_BRIEF_CHARS) : "（纯音乐或暂无歌词）";
    const mood = analyzeLyricMood(track);
    const parts = [
        `歌名：《${track.title || "未知歌曲"}》`,
        `歌手：${track.artist || "未知歌手"}`,
        track.album ? `专辑：《${track.album}》` : "",
        currentTimeSec > 0 ? `当前播放进度：约 ${Math.floor(currentTimeSec)} 秒` : "",
        currentLyricLine ? `正在唱到这句：「${currentLyricLine}」` : "",
        `歌词片段（前 ${LYRIC_BRIEF_CHARS} 字）：${lyricExcerpt}`,
        `歌曲情绪氛围关键词：${mood}`,
    ].filter(Boolean);
    return parts.join("\n");
}

export function formatMoodMemoryForPrompt(characterId: string, trackId: string): string {
    const mood = getListenMood(characterId, trackId);
    // 首次听某歌不注入（省 token）
    if (!mood || (mood.listenCount <= 1 && mood.recentComments.length === 0 && mood.skipWantedCount === 0 && mood.skipDeniedCount === 0)) {
        return "";
    }
    const lines: string[] = [`【你对这首歌的听歌记忆】`];
    lines.push(`- 之前已陪听过这首歌 ${mood.listenCount} 次。`);
    if (mood.recentComments.length > 0) {
        lines.push(`- 你上次听这首歌时说过：${mood.recentComments.map((c) => `「${c}」`).join("、")}（这次换个角度聊，别重复原话）。`);
    }
    if (mood.skipWantedCount > 0) {
        lines.push(`- 你之前有 ${mood.skipWantedCount} 次觉得这首歌不太对胃口想切歌。`);
    }
    if (mood.skipDeniedCount > 0) {
        lines.push(`- 注意：你之前提议切掉这首歌时被拒绝过 ${mood.skipDeniedCount} 次，说明对方很想听，这次别再主动提切歌。`);
    }
    return lines.join("\n");
}

// ── Invariant 4: Output Sanitization & Duplicate Detection ──
const TRAD_TO_SIMP_MAP: Record<string, string> = {
    "說": "说", "聽": "听", "愛": "爱", "風": "风", "雲": "云", "聲": "声", "樂": "乐",
    "詞": "词", "曲": "曲", "調": "调", "溫": "温", "柔": "柔", "懷": "怀", "念": "念",
    "淚": "泪", "傷": "伤", "難": "难", "過": "过", "歡": "欢", "喜": "喜", "點": "点",
    "頭": "头", "裡": "里", "着": "着", "著": "着", "這": "这", "個": "个", "們": "们",
    "嗎": "吗", "呢": "呢", "吧": "吧", "啊": "啊", "唄": "呗", "麼": "么", "樣": "样",
};

function normalizeForDedup(text: string): string {
    let out = String(text ?? "").toLowerCase();
    out = out.replace(/[\s\p{P}\p{S}~～·•、，。！？；：“”‘’「」『』（）()\[\]【】<>《》-]/gu, "");
    let converted = "";
    for (const ch of out) {
        converted += TRAD_TO_SIMP_MAP[ch] ?? ch;
    }
    return converted;
}

function makeBigrams(norm: string): Set<string> {
    const set = new Set<string>();
    if (norm.length < 2) {
        if (norm) set.add(norm);
        return set;
    }
    for (let i = 0; i < norm.length - 1; i++) {
        set.add(norm.slice(i, i + 2));
    }
    return set;
}

export function isListenDuplicate(candidate: string, existingList: string[]): boolean {
    const normCand = normalizeForDedup(candidate);
    if (!normCand) return true;
    const candBigrams = makeBigrams(normCand);

    for (const rawExisting of existingList) {
        const normExist = normalizeForDedup(rawExisting);
        if (!normExist) continue;
        if (normCand === normExist) return true;
        if (normCand.length >= 4 && normExist.length >= 4) {
            if (normCand.includes(normExist) || normExist.includes(normCand)) return true;
        }
        const existBigrams = makeBigrams(normExist);
        if (candBigrams.size > 0 && existBigrams.size > 0) {
            let intersection = 0;
            for (const bg of candBigrams) {
                if (existBigrams.has(bg)) intersection++;
            }
            const union = candBigrams.size + existBigrams.size - intersection;
            if (union > 0 && intersection / union >= 0.3) {
                return true;
            }
        }
    }
    return false;
}

/**
 * 出口清洗：剥代码块/HTML标签/markdown/（…）括号动作/引号/开头省略号，80字截断到最近句读。
 */
export function sanitizeListenText(raw: string | null | undefined, maxChars = BUBBLE_MAX_CHARS): string {
    if (!raw) return "";
    let text = String(raw);

    // 剥除  与代码块
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    text = text.replace(/```[\s\S]*?```/g, "");
    text = text.replace(/`([^`]+)`/g, "$1");

    // 剥除 HTML 标签
    text = text.replace(/<[^>]+>/g, "");

    // 剥除括号动作描写（中文圆括号、英文圆括号、方括号、心理/动作常见标记）
    text = text.replace(/（[^）]{1,60}）/g, "");
    text = text.replace(/\([^)]{1,60}\)/g, "");
    text = text.replace(/【[^】]{1,40}】/g, "");
    text = text.replace(/\[[^\]]{1,40}\]/g, "");
    text = text.replace(/\*[^*]{1,40}\*/g, "");

    // 剥除角色名前缀（如 "某某："）
    text = text.replace(/^[\u4e00-\u9fa5A-Za-z0-9_·-]{1,12}\s*[:：]\s*/, "");

    // 剥除 Markdown 强调与列表前缀
    text = text.replace(/(\*\*|__|~~)/g, "");
    text = text.replace(/^\s*[-*>#]+\s*/gm, "");

    // 合并多行与空白
    text = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();

    // 剥除外层引号与内部多余引号
    text = text.replace(/^[「『“"'‘]+|[」』”"'’]+$/g, "").trim();
    text = text.replace(/[「」『』“”"']/g, "");

    // 剥除开头省略号/破折号/标点
    text = text.replace(/^(?:\.{2,}|…+|—+|[-~～、，。！？；：\s])+/g, "").trim();

    if (!text) return "";

    if (text.length > maxChars) {
        const sliced = text.slice(0, maxChars);
        let cutIdx = -1;
        for (let i = sliced.length - 1; i >= Math.floor(maxChars * 0.45); i--) {
            if (/[。！？!?；;，,、]/.test(sliced[i])) {
                cutIdx = i;
                break;
            }
        }
        if (cutIdx >= 0) {
            const ch = sliced[cutIdx];
            text = /[。！？!?]/.test(ch) ? sliced.slice(0, cutIdx + 1) : `${sliced.slice(0, cutIdx)}。`;
        } else {
            text = sliced.trim();
        }
    }

    return text.trim();
}

// ── Invariant 5: Dynamic Skip Consensus Threshold ──
export function reachesConsensus(votesCount: number, totalParticipants: number): boolean {
    if (totalParticipants <= 1) return false; // 1人=不弹窗，走弹幕内嵌软确认
    if (totalParticipants === 2) return votesCount >= 1;
    return votesCount >= 2 || votesCount / totalParticipants >= 0.6;
}

// ── Prompt Assembly (Invariant 2) ──
function assertCharacterHasPersona(character: Character): void {
    const hasPersona = Boolean(character.persona?.trim());
    const hasPersonality = Boolean(character.personality?.trim());
    if (!hasPersona && !hasPersonality) {
        throw new Error(`角色「${character.name}」尚未填写人设（persona/personality 均为空），无法生成一起听弹幕`);
    }
}

function buildListenSystemPrompt(params: {
    character: Character;
    coListeners: Character[];
    track: MusicTrack;
    currentTimeSec?: number;
    currentLyricLine?: string;
    recentBubbles: ListenCommentEntry[];
    blacklist: string[];
    transition?: PreviousSkipTransition | null;
    taskInstruction: string;
}): string {
    const { character, coListeners, track, currentTimeSec = 0, currentLyricLine = "", recentBubbles, blacklist, transition, taskInstruction } = params;
    const userLabel = resolveUserLabel(character.id);
    const rawRelations = formatCharacterRelationsForPrompt(character.id);
    const relations = rawRelations ? renderUserNameMacro(rawRelations, userLabel) : "";
    const persona = trimPersona(renderUserNameMacro(character.persona || "", userLabel), PERSONA_CHAR_BUDGET);
    const personality = renderUserNameMacro(character.personality || "", userLabel).trim();
    const trackBrief = buildTrackBrief(track, currentTimeSec, currentLyricLine);
    const moodMemory = formatMoodMemoryForPrompt(character.id, track.id);

    const coNames = coListeners.filter((c) => c.id !== character.id).map((c) => c.name);
    const companionDesc = coNames.length > 0
        ? `此刻你正和「${userLabel}」以及 ${coNames.join("、")} 一起戴着耳机/在播放器里听同一首歌。`
        : `此刻你正和「${userLabel}」一起听同一首歌。`;

    const sections: string[] = [];
    sections.push(`你是「${character.name}」。${companionDesc}`);
    sections.push(`【身边人身份】\n正在陪你听歌的人叫「${userLabel}」。如果需要称呼对方，请自然使用符合你人设和你们关系的称呼，严禁凭空编造未出现在设定中的刻板称呼。`);

    if (relations) {
        sections.push(`【世界观与人物关系】\n${relations}`);
    }
    if (persona) {
        sections.push(`【你的人设与说话风格】\n${persona}`);
    }
    if (personality) {
        sections.push(`【你的性格特征】\n${personality}`);
    }

    sections.push(`【当前播放歌曲简报】\n${trackBrief}`);

    if (moodMemory) {
        sections.push(moodMemory);
    }

    if (transition && Date.now() - transition.at < 90_000) {
        const who = transition.proposerName ? `由「${transition.proposerName}」提议` : "刚刚";
        const why = transition.reason ? `（理由：「${transition.reason}」）` : "";
        sections.push(`【刚才】\n上一首歌《${transition.fromTitle}》${who}切到了现在这首《${track.title}》${why}。你可以顺着换歌后的新鲜感自然开口。`);
    }

    if (recentBubbles.length > 0) {
        const lines = recentBubbles.slice(-6).map((b) => `- ${b.characterName}：${b.text}`);
        sections.push(`【刚才的弹幕】\n${lines.join("\n")}\n（你可以自然接话、吐槽、共鸣，或者聊你注意到的旋律/歌词细节，不要照抄别人的话）`);
    }

    if (blacklist.length > 0) {
        const items = blacklist.slice(-10).map((t) => `- ${t}`);
        sections.push(`【禁止复读黑名单】\n以下是刚才已经发过的弹幕，绝对禁止重复相同的句式、比喻或意思：\n${items.join("\n")}`);
    }

    sections.push(`【输出铁律】\n1. 只输出你口中说出的一句简短弹幕（10～65字以内，绝不超过 ${BUBBLE_MAX_CHARS} 字）。\n2. 严禁输出任何括号动作/神态描写（如（轻笑）、(叹气)）、严禁加引号、严禁以省略号开头、严禁使用 Markdown 或代码块。\n3. 语气必须鲜活贴合你的人设说话风格，绝不能像音乐乐评人或客服。\n${taskInstruction}`);

    return sections.join("\n\n");
}

// ── Core LLM Actions ──
export async function generateListenComment(params: {
    character: Character;
    coListeners: Character[];
    track: MusicTrack;
    currentTimeSec?: number;
    currentLyricLine?: string;
    transition?: PreviousSkipTransition | null;
    signal?: AbortSignal;
}): Promise<ListenCommentEntry | null> {
    const { character, coListeners, track, currentTimeSec = 0, currentLyricLine = "", transition, signal } = params;
    assertCharacterHasPersona(character);

    const apiConfig = resolveCharacterApiConfig(character.id);
    if (!apiConfig) {
        throw new Error(`未找到可用的 API 配置，请先在「设置 → API 设置」中配置模型`);
    }

    const trackHistory = getTrackListenHistory(track.id);
    const mood = getListenMood(character.id, track.id);
    const blacklist = Array.from(new Set([
        ...trackHistory.slice(-12).map((item) => item.text),
        ...(mood?.recentComments ?? []),
    ]));

    const runAttempt = async (retryHint?: string): Promise<string> => {
        const sys = buildListenSystemPrompt({
            character,
            coListeners,
            track,
            currentTimeSec,
            currentLyricLine,
            recentBubbles: trackHistory.slice(-6),
            blacklist,
            transition,
            taskInstruction: retryHint
                ? `4. 刚才生成的句子与历史弹幕重复了！${retryHint}`
                : "4. 请直接说出你此刻听着这首歌的一句实时弹幕感想或对同伴的接话。",
        });
        const res = await simpleLLMCall(
            apiConfig,
            [
                { role: "system", content: sys },
                { role: "user", content: `正在播放《${track.title}》${currentLyricLine ? `（唱到：「${currentLyricLine}」）` : ""}，请发一条弹幕：` },
            ],
            { temperature: retryHint ? 0.92 : 0.82, max_tokens: 160, signal, label: `一起听点评:${character.name}` },
        );
        if (res.error) throw new Error(res.error);
        return sanitizeListenText(res.content);
    };

    let cleaned = await runAttempt();
    if (!cleaned) return null;

    if (isListenDuplicate(cleaned, blacklist)) {
        cleaned = await runAttempt(`请换一个完全不同的切入点（比如聊具体的某句歌词、节奏、或者直接和身边的同伴搭话），严禁与「${cleaned}」相似。`);
        if (!cleaned || isListenDuplicate(cleaned, blacklist)) {
            return null;
        }
    }

    recordMoodComment(character.id, track, cleaned);
    return appendListenHistory(track, {
        characterId: character.id,
        characterName: character.name,
        text: cleaned,
        kind: "comment",
    });
}

export async function decideListenSkip(params: {
    character: Character;
    coListeners: Character[];
    track: MusicTrack;
    currentTimeSec?: number;
    currentLyricLine?: string;
    forcePropose?: boolean;
    signal?: AbortSignal;
}): Promise<ListenSkipDecision | null> {
    const { character, coListeners, track, currentTimeSec = 0, currentLyricLine = "", forcePropose = false, signal } = params;
    assertCharacterHasPersona(character);

    const apiConfig = resolveCharacterApiConfig(character.id);
    if (!apiConfig) {
        throw new Error(`未找到可用的 API 配置，请先在「设置 → API 设置」中配置模型`);
    }

    const mood = getListenMood(character.id, track.id);
    // 如果非手动强制且之前在这首歌被拒过，尊重身边人不主动提切歌
    if (!forcePropose && mood && mood.skipDeniedCount > 0) {
        return {
            characterId: character.id,
            characterName: character.name,
            wantSkip: false,
            reason: "",
        };
    }

    const trackHistory = getTrackListenHistory(track.id);
    const blacklist = trackHistory.slice(-10).map((item) => item.text);

    const sys = buildListenSystemPrompt({
        character,
        coListeners,
        track,
        currentTimeSec,
        currentLyricLine,
        recentBubbles: trackHistory.slice(-5),
        blacklist,
        taskInstruction: forcePropose
            ? `4. 现在请你根据自己的口味判断要不要换下一首歌，用严格的 JSON 格式输出：{"wantSkip": true 或 false, "reason": "你口中说出的一句简短理由或听歌感想（不超过45字，无括号动作无引号）"}。`
            : `4. 这首歌已经播了一会儿。请根据你的人设口味判断：你是想继续听（wantSkip: false），还是觉得不太合胃口想提议切歌（wantSkip: true）？请只输出一行 JSON：{"wantSkip": boolean, "reason": "你口中说出的一句话（不超过45字，无括号动作无引号）"}。`,
    });

    const res = await simpleLLMCall(
        apiConfig,
        [
            { role: "system", content: sys },
            { role: "user", content: `请对《${track.title}》给出你的切歌评估 JSON：` },
        ],
        { temperature: 0.75, max_tokens: 160, signal, label: `一起听切歌评估:${character.name}` },
    );

    if (res.error || !res.content) return null;

    let wantSkip = false;
    let rawReason = "";
    const jsonMatch = res.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]) as { wantSkip?: unknown; skip?: unknown; reason?: unknown; comment?: unknown };
            wantSkip = Boolean(parsed.wantSkip ?? parsed.skip);
            rawReason = String(parsed.reason ?? parsed.comment ?? "");
        } catch {
            wantSkip = /"wantSkip"\s*:\s*true/i.test(res.content);
            rawReason = res.content.replace(/\{[\s\S]*\}/, "");
        }
    } else {
        wantSkip = /切歌|换一首|下一首/.test(res.content);
        rawReason = res.content;
    }

    const reason = sanitizeListenText(rawReason, 56);
    if (!reason) return null;

    if (wantSkip) {
        markSkipWanted(character.id, track);
    }

    return {
        characterId: character.id,
        characterName: character.name,
        wantSkip,
        reason,
    };
}
