'use client'

import {
  MediaControlBar,
  MediaController,
  MediaFullscreenButton,
  MediaLoadingIndicator,
  MediaMuteButton,
  MediaPipButton,
  MediaPlayButton,
  MediaPlaybackRateButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react'

/**
 * The Files screen's video and audio player (owner, 2026-09-20 — "kalau bisa
 * pakai media player library js atau apa gitu biar bagus").
 *
 * ## Why a library at all
 *
 * The tiles used to be bare `<video controls>` elements, which is the browser's
 * own chrome: a different shape and a different set of buttons in every
 * browser, no playback rate, no keyboard map worth the name, and nothing that
 * could be made to look like the rest of the farm. `media-chrome` (Mux, MIT)
 * is the smallest thing that fixes all of that at once — it is a set of custom
 * elements around a PLAIN `<video>`, not a media stack: no MSE, no adaptive
 * streaming, no second decoder. The element below is the same element the
 * browser was already playing; only the controls are ours.
 *
 * It is SSR-safe by construction (`media-chrome/dist/utils/server-safe-globals`
 * shims `customElements` under Node), which matters here because Studio is a
 * STATIC EXPORT — every page is prerendered at build time, and a library that
 * touched `document` on import would fail the build rather than the page.
 *
 * ## Why the controls are spelled out rather than a default layout
 *
 * `media-chrome` has no default layout; a caller composes the bar. That is the
 * reason to pick it over a player that ships its own skin: the farm's accent
 * is on the scrubber, the farm's font is in the timecode, and the two buttons
 * an operator here actually needs and a default layout never has — ±10 s, and
 * playback rate for scanning a long screen recording — are on the bar instead
 * of behind a menu. The styling is `.enkaku-player` in `globals.css`, in one
 * place, because it is CSS custom properties reaching into a shadow DOM and
 * that is not something to spread across call sites.
 */

/**
 * Seconds a skip button moves. Ten, matching every player an operator already
 * uses, and matching the arrow-key jump media-chrome does by default — the
 * button and the keyboard must not disagree about what "skip" means.
 */
const SEEK_OFFSET = 10

export function MediaPlayer({
  src,
  poster,
  kind,
  autoPlay = false,
  className,
}: {
  src: string
  /** A still to show before the first frame decodes. Only ever an image artifact's own URL — nothing is generated or stored (plan 800 wave 4). */
  poster?: string
  kind: 'video' | 'audio'
  autoPlay?: boolean
  className?: string
}) {
  return (
    <MediaController
      /*
       * `audio` swaps the controller from a picture with controls over it to a
       * bar with no picture at all — an mp3 upload otherwise renders as a
       * large black rectangle that looks like a video that failed to load.
       */
      audio={kind === 'audio' ? true : undefined}
      /*
       * Arrow keys are the DIALOG's, not the player's: ← and → move to the
       * previous and next file, which is what they do in every file manager,
       * and a player that ate them would strand an operator inside one clip.
       * Everything else media-chrome binds stays — space and k for play/pause,
       * m for mute, f for fullscreen, c for captions.
       */
      hotkeys="noarrowleft noarrowright"
      className={`enkaku-player ${className ?? ''}`}
    >
      {/*
       * `preload="metadata"`, never `auto`: this core shares a laptop with
       * every phone it is driving, and pulling a gigabyte of video the moment
       * a dialog opens is bandwidth the farm needs. Metadata is enough to draw
       * the duration and the first frame, and the seeking that follows is what
       * `GET /api/artifacts/:id/content`'s range support is there to serve.
       *
       * `crossOrigin` is deliberately NOT set. The bytes come from the core
       * with the session cookie, and an anonymous cross-origin request would
       * be the one shape that arrives unauthenticated — in Studio dev on :3001
       * that is a 401 rendered as a broken file.
       */}
      <video
        slot="media"
        src={src}
        poster={poster}
        preload="metadata"
        autoPlay={autoPlay}
        playsInline
        // A library is browsed by scrubbing, not by watching to the end —
        // looping saves the reach for the replay button every time.
        loop
        className="size-full"
      />

      <MediaLoadingIndicator slot="centered-chrome" noAutohide />

      <MediaControlBar>
        <MediaPlayButton />
        <MediaSeekBackwardButton seekOffset={SEEK_OFFSET} />
        <MediaSeekForwardButton seekOffset={SEEK_OFFSET} />
        <MediaTimeRange />
        {/* One element, not a time plus a separator plus a duration: the
            control bar aligns its own children, and a bare `<span>` between
            two of them sits on a line of its own. `showDuration` is the
            element's own "0:12 / 5:03". */}
        <MediaTimeDisplay showDuration />
        <MediaMuteButton />
        <MediaVolumeRange />
        {/* An array of numbers, which the React wrapper joins into the
            space-separated attribute the element reads (`toAttributeValue`
            in `media-chrome/react`). 4× is on the list because scanning a
            forty-minute screen recording for the one moment that matters is
            what this player is most often opened for. */}
        <MediaPlaybackRateButton rates={[0.5, 1, 1.5, 2, 4]} />
        {/*
         * Picture-in-picture and fullscreen are meaningless for audio — the
         * bar would carry two buttons that either do nothing or open a black
         * rectangle.
         */}
        {kind === 'video' && <MediaPipButton />}
        {kind === 'video' && <MediaFullscreenButton />}
      </MediaControlBar>
    </MediaController>
  )
}
