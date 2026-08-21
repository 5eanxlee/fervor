'use client';

import {
    ArrowPathIcon,
    CheckIcon,
    ChevronDownIcon,
    ClockIcon,
    ForwardIcon,
    PauseIcon,
    PlayIcon,
} from '@heroicons/react/24/outline';
import { useState } from 'react';
import type { ReplayOp, ReplaySpeed, ReplayState } from '../../services/replay';

const speeds: readonly ReplaySpeed[] = [1, 20, 100, 'max'];
export type ReplayRange = 'preview' | 'full';
export const replayPreviewTrades = 5_516;

interface ReplayControlsProps {
    replay?: ReplayState;
    now?: string;
    speed: ReplaySpeed;
    range: ReplayRange;
    busy: boolean;
    notice?: string;
    onSpeed: (speed: ReplaySpeed) => void;
    onRange: (range: ReplayRange) => void;
    onControl: (command: ReplayOp) => void;
}

const speedLabel = (speed: ReplaySpeed) => speed === 'max' ? 'Max' : `${speed}×`;

const replayTime = (value: string | null | undefined, full = false) => {
    if (!value) return 'Waiting for replay data';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Replay time unavailable';
    return new Intl.DateTimeFormat('en-US', {
        ...(full ? { month: 'short', day: '2-digit', year: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'UTC',
        timeZoneName: 'short',
    }).format(date);
};

export default function ReplayControls({
    replay,
    now,
    speed,
    range,
    busy,
    notice,
    onSpeed,
    onRange,
    onControl,
}: ReplayControlsProps) {
    const [openMenu, setOpenMenu] = useState<'range' | 'speed'>();
    const snapshot = replay?.snapshot;
    const running = snapshot?.status === 'running';
    const complete = snapshot?.status === 'complete';
    const paused = snapshot?.status === 'paused';
    const canStep = Boolean(snapshot && (paused || complete));
    const canReset = Boolean(snapshot && snapshot.cursor > 0 && (paused || complete));
    const fullTotal = snapshot?.total ?? 0;
    const rangeTotal = range === 'preview' ? Math.min(replayPreviewTrades, fullTotal) : fullTotal;
    const rangeCursor = Math.min(snapshot?.cursor ?? 0, rangeTotal);
    const progress = rangeTotal ? Math.min(100, rangeCursor / rangeTotal * 100) : 0;
    const currentTime = now || snapshot?.now;
    let transportTitle = 'Play replay';
    if (running) transportTitle = 'Pause replay';
    else if (complete) transportTitle = 'Replay from the beginning';

    return (
        <section className="replay-controls" aria-label="Replay controls">
            <div className="replay-transport" role="group" aria-label="Replay transport">
                <button
                    type="button"
                    onClick={() => onControl(running ? { op: 'pause' } : { op: 'play', speed })}
                    disabled={busy || !snapshot}
                    className="replay-primary"
                    title={transportTitle}
                >
                    {running ? <PauseIcon /> : <PlayIcon />}
                    <span>{running ? 'Pause' : 'Play'}</span>
                </button>
                <button
                    type="button"
                    onClick={() => onControl({ op: 'step' })}
                    disabled={busy || !canStep}
                    className="replay-action"
                    title="Advance one canonical trade"
                >
                    <ForwardIcon />
                    <span>Step</span>
                </button>
                <button
                    type="button"
                    onClick={() => onControl({ op: 'seek', target: 0 })}
                    disabled={busy || !canReset}
                    className="replay-action"
                    title="Reset replay to the beginning"
                >
                    <ArrowPathIcon />
                    <span>Reset</span>
                </button>
            </div>

            <div className="replay-speed">
                <span className="replay-label">Range</span>
                <div className="replay-speed-menu">
                    <button
                        type="button"
                        className="replay-speed-trigger replay-range-trigger"
                        onClick={() => setOpenMenu((open) => open === 'range' ? undefined : 'range')}
                        disabled={busy || running || !snapshot}
                        aria-haspopup="listbox"
                        aria-expanded={openMenu === 'range'}
                        aria-label="Replay range"
                    >
                        <ClockIcon />
                        <span>{range === 'preview' ? '11 min' : 'Full'}</span>
                        <ChevronDownIcon />
                    </button>
                    {openMenu === 'range' && (
                        <>
                            <button type="button" className="replay-menu-backdrop" onClick={() => setOpenMenu(undefined)} aria-label="Close replay range menu" />
                            <div className="replay-menu replay-range-menu" role="listbox" aria-label="Replay range">
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={range === 'preview'}
                                    onClick={() => {
                                        onRange('preview');
                                        setOpenMenu(undefined);
                                    }}
                                >
                                    <span><strong>First 11 min</strong><small>5,516 trades</small></span>
                                    {range === 'preview' && <CheckIcon />}
                                </button>
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={range === 'full'}
                                    disabled={fullTotal <= replayPreviewTrades}
                                    onClick={() => {
                                        onRange('full');
                                        setOpenMenu(undefined);
                                    }}
                                >
                                    <span><strong>Full capture</strong><small>{fullTotal > replayPreviewTrades ? `${fullTotal.toLocaleString()} trades` : 'Preparing source'}</small></span>
                                    {range === 'full' && <CheckIcon />}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="replay-speed">
                <span className="replay-label">Speed</span>
                <div className="replay-speed-menu">
                    <button
                        type="button"
                        className="replay-speed-trigger"
                        onClick={() => setOpenMenu((open) => open === 'speed' ? undefined : 'speed')}
                        disabled={busy || running}
                        aria-haspopup="listbox"
                        aria-expanded={openMenu === 'speed'}
                        aria-label={`Replay speed ${speedLabel(speed)}`}
                    >
                        <span>{speedLabel(speed)}</span>
                        <ChevronDownIcon />
                    </button>
                    {openMenu === 'speed' && (
                        <>
                            <button type="button" className="replay-menu-backdrop" onClick={() => setOpenMenu(undefined)} aria-label="Close replay speed menu" />
                            <div className="replay-menu" role="listbox" aria-label="Replay speed">
                                {speeds.map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        role="option"
                                        aria-selected={speed === value}
                                        onClick={() => {
                                            onSpeed(value);
                                            setOpenMenu(undefined);
                                        }}
                                    >
                                        <span>{speedLabel(value)}</span>
                                        {speed === value && <CheckIcon />}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="replay-progress">
                <div className="replay-progress-copy">
                    <span className="replay-state" data-status={snapshot?.status || 'loading'}>
                        <i aria-hidden="true" />
                        {snapshot?.status || 'loading'}
                    </span>
                    <time dateTime={currentTime || undefined} title={replayTime(currentTime, true)}>{replayTime(currentTime)}</time>
                    <span className="replay-count">
                        {snapshot ? `${rangeCursor.toLocaleString()} / ${rangeTotal.toLocaleString()}` : '—'}
                    </span>
                </div>
                <div
                    className="replay-track"
                    role="progressbar"
                    aria-label="Replay progress"
                    aria-valuemin={0}
                    aria-valuemax={rangeTotal}
                    aria-valuenow={rangeCursor}
                >
                    <span style={{ width: `${progress}%` }} />
                </div>
            </div>

            {notice && <span className="replay-notice" title={notice}>{notice}</span>}
        </section>
    );
}
