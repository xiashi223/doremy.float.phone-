"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MusicTrack } from "@/lib/music-storage";
import {
    appendListenHistory,
    decideListenSkip,
    generateListenComment,
    getTrackListenHistory,
    markSkipDenied,
    reachesConsensus,
    recordTrackListenExposure,
    type ListenCommentEntry,
    type ListenTogetherSession,
    type PreviousSkipTransition,
} from "@/lib/music-listen-together";

// ── Scheduling & Skip Constants (Invariant 5 & 8) ──
export const BUBBLE_TTL = 7000;
export const MAX_BUBBLES = 5;
export const SKIP_PROBABILITY = 0.22;
export const MIN_EVAL_PLAYED = 60; // 已播 >= 60s 才可自动评估切歌
export const AUTO_EVAL_GAP_MS = 45_000; // 两次自动评估间隔 >= 45s
export const DENY_COOLDOWN_MS = 3 * 60 * 1000; // 用户拒绝后 3 分钟冷却
export const AUTO_SKIP_DENY_LIMIT = 3; // 同会话被拒满 3 次停用自动提议
const SOFT_SKIP_BTN_TTL_MS = 15_000; // 1人模式弹幕内嵌「切歌」按钮 15s 消失

type LiveBubble = ListenCommentEntry & {
    avatar?: string | null;
    expiresAt: number;
    softSkipExpiresAt?: number;
};

type SkipVoteModalState = {
    trackId: string;
    trackTitle: string;
    voters: { characterId: string; characterName: string; reason: string }[];
};

type Props = {
    session: ListenTogetherSession;
    track: MusicTrack;
    currentTime: number;
    isPlaying: boolean;
    activeLyricText?: string;
    onSkipTrack: () => void;
    onOpenPanel: () => void;
    onToast?: (msg: string) => void;
};

export default function ListenTogetherLayer({
    session,
    track,
    currentTime,
    isPlaying,
    activeLyricText = "",
    onSkipTrack,
    onOpenPanel,
    onToast,
}: Props) {
    const [bubbles, setBubbles] = useState<LiveBubble[]>([]);
    const [busyLabel, setBusyLabel] = useState<string | null>(null);
    const [layerError, setLayerError] = useState<string | null>(null);
    const [skipModal, setSkipModal] = useState<SkipVoteModalState | null>(null);
    const [, setNowTick] = useState(0);

    const charactersMap = useMemo(() => {
        const map = new Map<string, Character>();
        for (const c of loadCharacters()) map.set(c.id, c);
        return map;
    }, [session.characterIds]);

    const participants = useMemo(
        () => session.characterIds.map((id) => charactersMap.get(id)).filter((c): c is Character => Boolean(c)),
        [session.characterIds, charactersMap],
    );

    // Refs for mutable scheduling & vote tracking
    const trackRef = useRef(track);
    trackRef.current = track;
    const currentTimeRef = useRef(currentTime);
    currentTimeRef.current = currentTime;
    const isPlayingRef = useRef(isPlaying);
    isPlayingRef.current = isPlaying;
    const lyricRef = useRef(activeLyricText);
    lyricRef.current = activeLyricText;
    const participantsRef = useRef(participants);
    participantsRef.current = participants;

    const lastSpeakerIdRef = useRef<string>("");
    const lastAutoEvalAtRef = useRef<number>(0);
    const denyCooldownUntilRef = useRef<number>(0);
    const sessionDenyCountRef = useRef<number>(0);
    const consecutiveAutoFailRef = useRef<number>(0);
    const trackVotesRef = useRef<Map<string, { characterId: string; characterName: string; reason: string }>>(new Map());
    const transitionRef = useRef<PreviousSkipTransition | null>(null);
    const busyRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);

    const pushBubble = useCallback((entry: ListenCommentEntry, opts?: { withSoftSkip?: boolean }) => {
        const char = charactersMap.get(entry.characterId);
        const now = Date.now();
        const nextBubble: LiveBubble = {
            ...entry,
            avatar: char?.avatar ?? null,
            expiresAt: now + BUBBLE_TTL,
            softSkipExpiresAt: opts?.withSoftSkip ? now + SOFT_SKIP_BTN_TTL_MS : undefined,
        };
        setBubbles((prev) => [...prev.slice(-(MAX_BUBBLES - 1)), nextBubble]);
    }, [charactersMap]);

    // Expire bubbles & soft-skip buttons periodically
    useEffect(() => {
        const timer = window.setInterval(() => {
            const now = Date.now();
            setBubbles((prev) => {
                const filtered = prev.filter((b) => b.expiresAt > now);
                const softChanged = filtered.some((b) => b.softSkipExpiresAt && b.softSkipExpiresAt <= now);
                if (filtered.length === prev.length && !softChanged) return prev;
                return filtered.map((b) => (
                    b.softSkipExpiresAt && b.softSkipExpiresAt <= now
                        ? { ...b, softSkipExpiresAt: undefined }
                        : b
                ));
            });
            setNowTick((t) => (t + 1) % 1000);
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);

    // Reset per-track votes & load recent 2 bubbles when track changes
    useEffect(() => {
        trackVotesRef.current.clear();
        setSkipModal(null);
        setLayerError(null);
        recordTrackListenExposure(session.characterIds, track);

        const history = getTrackListenHistory(track.id).slice(-2);
        const now = Date.now();
        setBubbles(
            history.map((item, idx) => ({
                ...item,
                avatar: charactersMap.get(item.characterId)?.avatar ?? null,
                expiresAt: now + BUBBLE_TTL + idx * 1200,
            })),
        );
    }, [track.id, session.characterIds, charactersMap, track]);

    useEffect(() => () => abortRef.current?.abort(), []);

    // Pick next speaker (prefer proposer right after a skip transition, otherwise avoid repeating last speaker)
    const pickNextCharacter = useCallback((): Character | null => {
        const list = participantsRef.current;
        if (list.length === 0) return null;
        const trans = transitionRef.current;
        if (trans?.proposerId && Date.now() - trans.at < 45_000) {
            const proposer = list.find((c) => c.id === trans.proposerId);
            if (proposer) {
                transitionRef.current = { ...trans, proposerId: undefined };
                return proposer;
            }
        }
        if (list.length === 1) return list[0];
        const candidates = list.filter((c) => c.id !== lastSpeakerIdRef.current);
        return candidates[Math.floor(Math.random() * candidates.length)] ?? list[0];
    }, []);

    const executeSkipConfirmed = useCallback((proposer?: { characterId?: string; characterName?: string; reason?: string }) => {
        const cur = trackRef.current;
        transitionRef.current = {
            fromTitle: cur.title,
            fromArtist: cur.artist,
            proposerId: proposer?.characterId,
            proposerName: proposer?.characterName,
            reason: proposer?.reason,
            at: Date.now(),
        };
        trackVotesRef.current.clear();
        setSkipModal(null);
        onSkipTrack();
    }, [onSkipTrack]);

    const handleUserDenySkip = useCallback(() => {
        const cur = trackRef.current;
        const voters = Array.from(trackVotesRef.current.values());
        markSkipDenied(
            voters.length > 0 ? voters.map((v) => v.characterId) : session.characterIds,
            cur,
        );
        trackVotesRef.current.clear();
        denyCooldownUntilRef.current = Date.now() + DENY_COOLDOWN_MS;
        sessionDenyCountRef.current += 1;
        setSkipModal(null);
        const overLimit = sessionDenyCountRef.current >= AUTO_SKIP_DENY_LIMIT;
        onToast?.(overLimit ? "已拒绝切歌，本场不再自动提议切歌" : "已留下继续听（3分钟内不再提议）");
    }, [session.characterIds, onToast]);

    // Evaluate skip for one character (auto or manual)
    const runSkipEvaluationFor = useCallback(async (char: Character, forcePropose = false, signal?: AbortSignal) => {
        const curTrack = trackRef.current;
        const decision = await decideListenSkip({
            character: char,
            coListeners: participantsRef.current,
            track: curTrack,
            currentTimeSec: currentTimeRef.current,
            currentLyricLine: lyricRef.current,
            forcePropose,
            signal,
        });
        if (!decision || curTrack.id !== trackRef.current.id) return;

        const total = participantsRef.current.length;
        if (!decision.wantSkip) {
            const entry = appendListenHistory(curTrack, {
                characterId: char.id,
                characterName: char.name,
                text: decision.reason,
                kind: "comment",
            });
            pushBubble(entry);
            return;
        }

        // 1人模式：不弹窗，弹幕内嵌「切歌」小按钮软确认（15s超时消失）
        if (total === 1) {
            const entry = appendListenHistory(curTrack, {
                characterId: char.id,
                characterName: char.name,
                text: decision.reason,
                kind: "skip-propose",
            });
            pushBubble(entry, { withSoftSkip: true });
            return;
        }

        // 多人模式：记票并判断 reachesConsensus
        trackVotesRef.current.set(char.id, {
            characterId: char.id,
            characterName: char.name,
            reason: decision.reason,
        });
        const votesCount = trackVotesRef.current.size;
        const consensus = reachesConsensus(votesCount, total);
        const entry = appendListenHistory(curTrack, {
            characterId: char.id,
            characterName: char.name,
            text: decision.reason,
            kind: consensus ? "skip-propose" : "skip-mutter",
        });
        pushBubble(entry);

        if (consensus) {
            setSkipModal({
                trackId: curTrack.id,
                trackTitle: curTrack.title,
                voters: Array.from(trackVotesRef.current.values()),
            });
        }
    }, [pushBubble]);

    // Single automatic tick
    const runAutoTick = useCallback(async () => {
        if (busyRef.current || !isPlayingRef.current || participantsRef.current.length === 0) return;
        const speaker = pickNextCharacter();
        if (!speaker) return;

        busyRef.current = true;
        const controller = new AbortController();
        abortRef.current = controller;
        const now = Date.now();

        const canAutoSkipEval =
            sessionDenyCountRef.current < AUTO_SKIP_DENY_LIMIT &&
            now >= denyCooldownUntilRef.current &&
            currentTimeRef.current >= MIN_EVAL_PLAYED &&
            now - lastAutoEvalAtRef.current >= AUTO_EVAL_GAP_MS &&
            Math.random() < SKIP_PROBABILITY;

        try {
            setBusyLabel(`${speaker.name} 正在听…`);
            if (canAutoSkipEval) {
                lastAutoEvalAtRef.current = now;
                await runSkipEvaluationFor(speaker, false, controller.signal);
            } else {
                const entry = await generateListenComment({
                    character: speaker,
                    coListeners: participantsRef.current,
                    track: trackRef.current,
                    currentTimeSec: currentTimeRef.current,
                    currentLyricLine: lyricRef.current,
                    transition: transitionRef.current,
                    signal: controller.signal,
                });
                if (entry && trackRef.current.id === entry.trackId) {
                    lastSpeakerIdRef.current = speaker.id;
                    pushBubble(entry);
                }
            }
            consecutiveAutoFailRef.current = 0;
            setLayerError(null);
        } catch (err) {
            consecutiveAutoFailRef.current += 1;
            const msg = err instanceof Error ? err.message : "生成失败";
            if (consecutiveAutoFailRef.current >= 2) {
                setLayerError(`弹幕暂未响应：${msg}`);
            }
        } finally {
            busyRef.current = false;
            setBusyLabel(null);
        }
    }, [pickNextCharacter, pushBubble, runSkipEvaluationFor]);

    // Scheduler loop: scheduleNext
    useEffect(() => {
        if (!session.active || participants.length === 0) return;
        let timer: number | null = null;
        let cancelled = false;

        const scheduleNext = (initial = false) => {
            if (cancelled) return;
            const minMs = Math.max(8, session.intervalMin) * 1000;
            const maxMs = Math.max(minMs + 2000, session.intervalMax * 1000);
            const delay = initial
                ? 4500
                : Math.round(minMs + Math.random() * (maxMs - minMs));
            timer = window.setTimeout(async () => {
                if (cancelled) return;
                await runAutoTick();
                scheduleNext(false);
            }, delay);
        };

        scheduleNext(true);
        return () => {
            cancelled = true;
            if (timer) window.clearTimeout(timer);
        };
    }, [session.active, session.intervalMin, session.intervalMax, participants.length, track.id, runAutoTick]);

    // Manual: 「一起评」串行触发全部角色发言（后面的能看到前面的弹幕，验证接话）
    const handleAllComment = useCallback(async () => {
        if (busyRef.current || participantsRef.current.length === 0) return;
        busyRef.current = true;
        setLayerError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        const startTrackId = trackRef.current.id;

        try {
            for (const char of participantsRef.current) {
                if (controller.signal.aborted || trackRef.current.id !== startTrackId) break;
                setBusyLabel(`${char.name} 正在点评…`);
                const entry = await generateListenComment({
                    character: char,
                    coListeners: participantsRef.current,
                    track: trackRef.current,
                    currentTimeSec: currentTimeRef.current,
                    currentLyricLine: lyricRef.current,
                    transition: transitionRef.current,
                    signal: controller.signal,
                });
                if (entry && trackRef.current.id === startTrackId) {
                    lastSpeakerIdRef.current = char.id;
                    pushBubble(entry);
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "点评失败";
            setLayerError(msg);
            onToast?.(msg);
        } finally {
            busyRef.current = false;
            setBusyLabel(null);
        }
    }, [pushBubble, onToast]);

    // Manual: 「问切歌」手动让角色评估是否切歌
    const handleAskSkip = useCallback(async () => {
        if (busyRef.current || participantsRef.current.length === 0) return;
        busyRef.current = true;
        setLayerError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        const startTrackId = trackRef.current.id;

        try {
            for (const char of participantsRef.current) {
                if (controller.signal.aborted || trackRef.current.id !== startTrackId) break;
                setBusyLabel(`询问 ${char.name}…`);
                await runSkipEvaluationFor(char, true, controller.signal);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : "询问切歌失败";
            setLayerError(msg);
            onToast?.(msg);
        } finally {
            busyRef.current = false;
            setBusyLabel(null);
        }
    }, [runSkipEvaluationFor, onToast]);

    return (
        <div className="lt-layer" aria-live="polite">
            {/* 顶部陪听状态与操作条（定位与播放器头部同源） */}
            <div className="lt-live-bar">
                <button type="button" className="lt-live-avatars" onClick={onOpenPanel} title="调整一起听设置">
                    {participants.slice(0, 4).map((c) => (
                        c.avatar ? (
                            <img key={c.id} src={c.avatar} alt={c.name} className="lt-mini-avatar" />
                        ) : (
                            <span key={c.id} className="lt-mini-avatar lt-mini-avatar-fallback">
                                {c.name.slice(0, 1)}
                            </span>
                        )
                    ))}
                    <span className="lt-live-status">
                        {busyLabel || `${participants.map((c) => c.name).join("、")} 陪听中`}
                    </span>
                </button>
                <div className="lt-live-actions">
                    <button
                        type="button"
                        className="lt-chip-btn"
                        disabled={Boolean(busyLabel)}
                        onClick={() => void handleAllComment()}
                        title="让所有陪听角色依次发弹幕接话"
                    >
                        一起评
                    </button>
                    <button
                        type="button"
                        className="lt-chip-btn"
                        disabled={Boolean(busyLabel)}
                        onClick={() => void handleAskSkip()}
                        title="问问大家想不想切歌"
                    >
                        问切歌
                    </button>
                </div>
            </div>

            {layerError ? (
                <div className="lt-layer-error" onClick={() => setLayerError(null)}>
                    <span>⚠ {layerError}</span>
                    <small>点此关闭</small>
                </div>
            ) : null}

            {/* 右下角弹幕堆叠（最多 5 条） */}
            <div className="lt-bubble-stack">
                {bubbles.map((b) => {
                    const showSoftSkip = Boolean(b.softSkipExpiresAt && b.softSkipExpiresAt > Date.now());
                    return (
                        <div key={b.id} className="lt-bubble" data-kind={b.kind}>
                            <div className="lt-bubble-head">
                                {b.avatar ? (
                                    <img src={b.avatar} alt={b.characterName} className="lt-bubble-avatar" />
                                ) : (
                                    <span className="lt-bubble-avatar lt-bubble-avatar-fallback">
                                        {b.characterName.slice(0, 1)}
                                    </span>
                                )}
                                <span className="lt-bubble-name">{b.characterName}</span>
                            </div>
                            <div className="lt-bubble-text">{b.text}</div>
                            {showSoftSkip ? (
                                <div className="lt-bubble-soft-actions">
                                    <button
                                        type="button"
                                        className="lt-soft-skip-btn"
                                        onClick={() => executeSkipConfirmed({
                                            characterId: b.characterId,
                                            characterName: b.characterName,
                                            reason: b.text,
                                        })}
                                    >
                                        听TA的 · 切歌 ⏭
                                    </button>
                                    <button
                                        type="button"
                                        className="lt-soft-keep-btn"
                                        onClick={handleUserDenySkip}
                                    >
                                        继续听
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {/* 多人切歌共识弹窗 */}
            {skipModal ? (
                <div className="lt-skip-modal-mask" onClick={handleUserDenySkip}>
                    <div className="lt-skip-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="lt-skip-modal-title">同伴提议切歌</div>
                        <div className="lt-skip-modal-desc">
                            正在播放《{skipModal.trackTitle}》，{skipModal.voters.length} 位陪听角色想换下一首：
                        </div>
                        <div className="lt-skip-voters">
                            {skipModal.voters.map((v) => (
                                <div key={v.characterId} className="lt-skip-voter-row">
                                    <b>{v.characterName}：</b>
                                    <span>{v.reason}</span>
                                </div>
                            ))}
                        </div>
                        <div className="lt-skip-modal-actions">
                            <button type="button" className="lt-btn lt-btn-stop" onClick={handleUserDenySkip}>
                                继续听这首
                            </button>
                            <button
                                type="button"
                                className="lt-btn lt-btn-primary"
                                onClick={() => executeSkipConfirmed(skipModal.voters[0])}
                            >
                                同意切歌 ⏭
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
