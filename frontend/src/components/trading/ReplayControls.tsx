'use client';

import {
    ArrowPathIcon,
    ForwardIcon,
    PauseIcon,
    PlayIcon,
} from '@heroicons/react/24/outline';
import type { ReplayOp, ReplaySpeed, ReplayState } from '../../services/replay';

const speeds: readonly ReplaySpeed[] = [1, 20, 100, 'max'];

interface ReplayControlsProps {
    replay?: ReplayState;
    speed: ReplaySpeed;
    busy: boolean;
    notice?: string;
    onSpeed: (speed: ReplaySpeed) => void;
    onControl: (command: ReplayOp) => void;
}

const speedLabel = (speed: ReplaySpeed) => speed === 'max' ? 'Max' : `${speed}×`;

const replayTime = (value: string | null | undefined) => {
    if (!value) return 'Waiting for replay data';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Replay time unavailable';
    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
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
    speed,
    busy,
    notice,
    onSpeed,
    onControl,
}: ReplayControlsProps) {
    const snapshot = replay?.snapshot;
    const running = snapshot?.status === 'running';
    const complete = snapshot?.status === 'complete';
    const paused = snapshot?.status === 'paused';
    const canStep = Boolean(snapshot && (paused || complete));
    const canReset = Boolean(snapshot && snapshot.cursor > 0 && (paused || complete));
    const progress = snapshot?.total ? Math.min(100, snapshot.cursor / snapshot.total * 100) : 0;
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
                <span className="replay-label">Speed</span>
                <div className="replay-speed-options" role="group" aria-label="Replay speed">
                    {speeds.map((value) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => onSpeed(value)}
                            disabled={busy || running}
                            aria-pressed={speed === value}
                        >
                            {speedLabel(value)}
                        </button>
                    ))}
                </div>
            </div>

            <div className="replay-progress">
                <div className="replay-progress-copy">
                    <span className="replay-state" data-status={snapshot?.status || 'loading'}>
                        <i aria-hidden="true" />
                        {snapshot?.status || 'loading'}
                    </span>
                    <time dateTime={snapshot?.now || undefined}>{replayTime(snapshot?.now)}</time>
                    <span className="replay-count">
                        {snapshot ? `${snapshot.cursor.toLocaleString()} / ${snapshot.total.toLocaleString()}` : '—'}
                    </span>
                </div>
                <div
                    className="replay-track"
                    role="progressbar"
                    aria-label="Replay progress"
                    aria-valuemin={0}
                    aria-valuemax={snapshot?.total || 0}
                    aria-valuenow={snapshot?.cursor || 0}
                >
                    <span style={{ width: `${progress}%` }} />
                </div>
            </div>

            {notice && <span className="replay-notice" title={notice}>{notice}</span>}
        </section>
    );
}
