'use client';

import { useRef, useState, useEffect } from 'react';

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptionViewerProps {
  audioUrl: string;
  text: string;
  segments?: string | null; // JSON string
  language: string;
  duration: number;
  wordCount: number;
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TranscriptionViewer({
  audioUrl,
  text,
  segments: segmentsJson,
  language,
  duration,
  wordCount,
}: TranscriptionViewerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const segments: Segment[] = segmentsJson
    ? JSON.parse(segmentsJson)
    : [];

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, []);

  const seekTo = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    audio.play();
  };

  const currentSegmentIndex = segments.findIndex(
    (seg) => currentTime >= seg.start && currentTime < seg.end
  );

  return (
    <div className="space-y-4">
      {/* Audio Player */}
      <div className="bg-muted rounded-lg p-4">
        <audio ref={audioRef} src={audioUrl} controls className="w-full" />
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-3 gap-4 text-sm text-muted-foreground">
        <div>
          <span className="font-medium text-foreground">Language</span>
          <p>{language?.toUpperCase() || 'Unknown'}</p>
        </div>
        <div>
          <span className="font-medium text-foreground">Duration</span>
          <p>{formatTimestamp(duration)}</p>
        </div>
        <div>
          <span className="font-medium text-foreground">Words</span>
          <p>{wordCount.toLocaleString()}</p>
        </div>
      </div>

      {/* Timestamped Segments */}
      {segments.length > 0 ? (
        <div className="space-y-2">
          <h4 className="font-medium">Timestamped Transcript</h4>
          <div className="bg-muted rounded-lg p-4 max-h-96 overflow-y-auto space-y-1">
            {segments.map((seg, i) => (
              <button
                key={i}
                onClick={() => seekTo(seg.start)}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors hover:bg-background ${
                  i === currentSegmentIndex ? 'bg-primary/10 text-primary' : ''
                }`}
              >
                <span className="font-mono text-xs text-muted-foreground mr-2">
                  {formatTimestamp(seg.start)}
                </span>
                {seg.text}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <h4 className="font-medium mb-2">Transcription</h4>
          <div className="bg-muted rounded-lg p-4 max-h-96 overflow-y-auto">
            <p className="text-sm whitespace-pre-wrap">{text}</p>
          </div>
        </div>
      )}
    </div>
  );
}
