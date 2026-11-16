"use client";

import { useEffect, useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    loadListenSelectedIds,
    loadListenSession,
    saveListenSelectedIds,
    startListenSession,
    stopListenSession,
    type ListenTogetherSession,
} from "@/lib/music-listen-together";

type Props = {
    open: boolean;
    onClose: () => void;
    onSessionChange: (session: ListenTogetherSession) => void;
    onToast?: (msg: string) => void;
};

const INTERVAL_PRESETS: { label: string; min: number; max: number; desc: string }[] = [
    { label: "热闹", min: 12, max: 22, desc: "12~22秒一句" },
    { label: "自然", min: 18, max: 32, desc: "18~32秒一句" },
    { label: "安静", min: 30, max: 50, desc: "30~50秒一句" },
];

export default function ListenTogetherPanel({ open, onClose, onSessionChange, onToast }: Props) {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [intervalMin, setIntervalMin] = useState(18);
    const [intervalMax, setIntervalMax] = useState(32);
    const [sessionActive, setSessionActive] = useState(false);

    useEffect(() => {
        if (!open) return;
        const chars = loadCharacters();
        setCharacters(chars);
        const session = loadListenSession();
        setSessionActive(session.active);
        setIntervalMin(session.intervalMin);
        setIntervalMax(session.intervalMax);
        const saved = session.characterIds.length > 0 ? session.characterIds : loadListenSelectedIds();
        if (saved.length > 0) {
            setSelectedIds(saved);
        } else if (chars.length > 0) {
            const firstWithPersona = chars.find((c) => c.persona?.trim() || c.personality?.trim()) ?? chars[0];
            setSelectedIds([firstWithPersona.id]);
        }
    }, [open]);

    if (!open) return null;

    const toggleChar = (id: string) => {
        setSelectedIds((prev) => {
            const next = prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id];
            saveListenSelectedIds(next);
            return next;
        });
    };

    const handleStartOrUpdate = () => {
        const picked = characters.filter((c) => selectedIds.includes(c.id));
        if (picked.length === 0) {
            onToast?.("请至少选择一位陪听角色");
            return;
        }
        const emptyPersonaChar = picked.find((c) => !c.persona?.trim() && !c.personality?.trim());
        if (emptyPersonaChar) {
            onToast?.(`角色「${emptyPersonaChar.name}」还没有填写人设，请先补充人设或换一位角色`);
            return;
        }
        const next = startListenSession(selectedIds, intervalMin, intervalMax);
        onSessionChange(next);
        onToast?.(`已开启与 ${picked.map((c) => c.name).join("、")} 一起听`);
        onClose();
    };

    const handleStop = () => {
        const next = stopListenSession();
        onSessionChange(next);
        onToast?.("已结束一起听");
        onClose();
    };

    return (
        <div className="lt-panel-overlay" onClick={onClose}>
            <div className="lt-panel-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="lt-panel-header">
                    <div>
                        <div className="lt-panel-title">音乐一起听</div>
                        <div className="lt-panel-sub">选几位角色戴上耳机陪你听歌、发实时弹幕</div>
                    </div>
                    <button type="button" className="lt-panel-close" onClick={onClose} aria-label="关闭">
                        ✕
                    </button>
                </div>

                <div className="lt-panel-section">
                    <div className="lt-panel-label">
                        <span>选择陪听角色</span>
                        <small>已选 {selectedIds.length} 人</small>
                    </div>
                    {characters.length === 0 ? (
                        <div className="lt-panel-empty">还没有创建角色，先去桌面找「小卷」或角色卡应用创建一位吧</div>
                    ) : (
                        <div className="lt-char-grid">
                            {characters.map((char) => {
                                const checked = selectedIds.includes(char.id);
                                const hasPersona = Boolean(char.persona?.trim() || char.personality?.trim());
                                return (
                                    <button
                                        key={char.id}
                                        type="button"
                                        className="lt-char-card"
                                        data-selected={checked ? "true" : undefined}
                                        data-warn={!hasPersona ? "true" : undefined}
                                        onClick={() => toggleChar(char.id)}
                                    >
                                        <div className="lt-char-avatar-wrap">
                                            {char.avatar ? (
                                                <img src={char.avatar} alt={char.name} className="lt-char-avatar" />
                                            ) : (
                                                <div className="lt-char-avatar lt-char-avatar-fallback">
                                                    {char.name.slice(0, 1)}
                                                </div>
                                            )}
                                            {checked ? <span className="lt-char-check">✓</span> : null}
                                        </div>
                                        <div className="lt-char-name">{char.name}</div>
                                        {!hasPersona ? <div className="lt-char-tag">缺人设</div> : null}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="lt-panel-section">
                    <div className="lt-panel-label">
                        <span>弹幕发言节奏</span>
                        <small>{intervalMin}~{intervalMax} 秒</small>
                    </div>
                    <div className="lt-interval-row">
                        {INTERVAL_PRESETS.map((preset) => {
                            const active = intervalMin === preset.min && intervalMax === preset.max;
                            return (
                                <button
                                    key={preset.label}
                                    type="button"
                                    className="lt-interval-btn"
                                    data-active={active ? "true" : undefined}
                                    onClick={() => {
                                        setIntervalMin(preset.min);
                                        setIntervalMax(preset.max);
                                    }}
                                >
                                    <b>{preset.label}</b>
                                    <span>{preset.desc}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="lt-panel-footer">
                    {sessionActive ? (
                        <button type="button" className="lt-btn lt-btn-stop" onClick={handleStop}>
                            结束一起听
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="lt-btn lt-btn-primary"
                        disabled={selectedIds.length === 0}
                        onClick={handleStartOrUpdate}
                    >
                        {sessionActive ? "更新陪听设置" : "开始一起听"}
                    </button>
                </div>
            </div>
        </div>
    );
}
