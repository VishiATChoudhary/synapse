# Screenshots and videos in the phone app's agent chat

Date: 2026-10-20. Status: draft for approval (builder check done).

## Why

Agents on the Mac make things the user wants to look at: screenshots of a UI they built, images they opened, videos they rendered or recorded. On the phone, the agent's chat shows only text, so the user has to wait until they are back at the Mac to see any of it. The user wants these to show up in the chat on their own, where the agent made them.

This is the first step toward a bigger goal: using a web UI an agent built (a dev server on the Mac) live from the phone. That live view is out of scope here; recordings of a UI are the stand-in for now.

## Goals

- Images an agent sees or makes appear inline in that agent's chat on the phone, at the point in the conversation where they happened. Tap opens one full screen (pinch to zoom).
- Videos an agent saves or names appear as a card in the chat (first frame, length, play button) and play inline or full screen.
- Works for Claude Code and Codex agents.
- On by default. One switch in the phone app's settings ("show images and videos") turns it off; while off, nothing is fetched.
- End to end encrypted like everything else between Mac and phone (NaCl box, the existing phone keys).

## Non-goals

- The live, interactive view of a web UI on the Mac (later project).
- Mirroring the Mac's screen.
- Sending original full-quality video files.
- Media in the desktop app's canvas or chat (only the phone changes).
- Gemini, OpenCode, Cursor and other agent kinds (text only, as today). The design should not make adding them later hard.
- Files that are not images or videos (PDFs, code files).

## Anti-goals (a failure even if it works)

- Anything that puts App Review at risk (see mobile/APP_STORE.md). Media is shown as images and video only, with native components: never a WebView, never HTML or code from the Mac (guideline 2.5.2).
- Media filling the relay mailbox so that text messages, state or other devices' items get dropped (the cloud evicts the oldest items once a machine's mailbox passes 8 MB).
- The phone downloading the same image or video again every time the chat updates or reopens.
- The chat becoming slow or janky with many screenshots.

## Constraints and what exists

**Where media lives**

- Claude Code transcripts (`~/.claude/projects/.../<session>.jsonl`) carry images inline as base64:
  - screenshots and images the agent read: `tool_result` content blocks in `user` entries, as `{ type: 'image', source: { type: 'base64', media_type, data } }`, png or jpeg, about 10 to 110 KB each;
  - images the user pasted: `image` blocks directly in user content.
- Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carry them as data URLs: `response_item` entries of type `function_call_output` or `custom_tool_call_output`, in `output[].image_url` (`data:image/png;base64,...` or jpeg), for example after `tools.view_image`, and images pasted into Codex as `input_image` blocks in user messages.
- Neither keeps videos in the transcript. A video is a file on disk that the agent wrote, rendered or mentioned (`.mp4`, `.mov`, `.m4v`, `.webm`, `.gif`). It shows up as a path in a tool call (a command's arguments, a Write target) or in the agent's text.

**Code paths today**

- `lib.mjs`: `claudeMessage` and `codexMessage` turn transcript entries into `{ role, text, ts, tool }` and drop everything else, including images.
- `app/phone.mjs`: `messagesOf(agent)` takes the last 40 messages (4000 characters each) and sends the whole list as one sealed `messages` item whenever it changes. Polls every 1.5 s while a phone is active.
- `mobile/src/app/agent/[id].js`: draws messages as text only. `mobile/src/remote.js` holds the messages per agent.

**Relay (Synapse Cloud) limits**

- Each item is sealed with NaCl box per phone.
- A request body may be up to 2 MB.
- A machine's mailbox holds up to 8 MB; past that, the oldest items are dropped.
- Items expire after a day.

**macOS tools**

- `avconvert` ships with macOS. It takes fixed presets (`Preset640x480`, `Preset960x540`, `Preset1280x720`, ...), but has no bitrate or size target.
- `ffmpeg` exists on this Mac (Homebrew), but not on every user's.

**Builds**

- Playing video needs a video library in the Expo app (`expo-video`), so this needs a new TestFlight build.
- The Mac side ships in a desktop release (signed and notarized, auto-update).
- The cloud changes only if the builder decides it must; the preferred design needs no cloud change.

## How it works (decided)

1. **Media in messages.** The transcript parsers keep media references with each message instead of dropping them:
   - images: kind, type and the bytes, or where to find them;
   - videos: a file path the Mac has checked exists and is a video.

   Each media item gets a stable id (for example a hash of its bytes, or of path plus size plus mtime), so the same image or video is never sent twice.
2. **Messages stay light.** The `messages` item sent to the phone carries only media ids and small metadata (kind, width and height if known, duration for video), never the bytes. The phone asks for the media it does not have yet.
3. **Images.** The phone requests an image by id, and the Mac sends it as its own sealed item. Large images are scaled down on the Mac to a phone-sized JPEG first (about 1600 px on the long side). The phone caches received images on disk, keyed by id, and does not ask again.
4. **Videos.** The Mac makes a phone-sized copy, aiming at 720p and **at most about 8 MB**.
   - If that doesn't fit, it lowers quality first, so long recordings get blurrier rather than failing.
   - The copy is cached on the Mac per media id, so it is made once.
   - It goes to the phone in sealed pieces, with the phone saying how much it has received, so only a few MB are ever waiting in the mailbox.
   - The phone stitches the pieces, caches the file, and plays it with a native player.
5. **On the phone.**
   - Images show inline under the message they belong to, as thumbnails that keep their shape; tap for full screen.
   - Videos show as a card with the first frame and duration, and an "on its way" state while the pieces arrive.
   - Nothing is fetched until the message scrolls into view or is close to it.
6. **The switch.** "Show images and videos" in settings, on by default, kept on the phone. When it is off, the phone asks for no media and shows nothing in its place.

## Calls I made (the user can overrule)

- The 8 MB cap and 720p target. The user agreed to "phone-quality, around 8 MB".
- macOS's own `avconvert` first, so the feature works on any Mac without installing anything. `ffmpeg` is used when present, because it can aim at a size precisely; GIFs need it too. Without `ffmpeg`, a GIF that isn't small enough to send as an image shows a "can't preview" card.
- Over the cap even at the lowest quality: send the first part that fits, and label the card "first 1:30 of 6:10" (or similar).
- Only videos the agent actually touched in that chat count (a path in its tool calls or text that exists on disk now). Video files lying around elsewhere don't.
- Images are kept as they appear in the transcript (one per tool result block), including the many screenshots an agent takes while testing. To keep the chat tidy, a run of images in tool messages with no text can collapse into one strip.
- The phone's media cache is capped (for example 300 MB, oldest first out).

- **Window:** a turn that is only images (a screenshot tool result with no text) is not a message of its own: its media attach to the nearest agent message before it. The 40-message window still counts text messages, so a testing session full of screenshots doesn't push the conversation off the phone. No paging to older history (as today). "Fetched when it scrolls into view" means lazily within that window. If inline images crowd the transcript tail the Mac reads, the read window widens, the way it already does for big tool outputs.
- **Platforms:** iOS only (TestFlight and App Store builds). The web build and Android keep showing text only, with no error.
- **Demo mode:** the sample agents get one sample screenshot and one short sample video, bundled and kept small (under about 1 MB together). App Review only sees demo mode, and a switch that visibly does nothing there would look unfinished (guideline 2.1).
- **When videos are converted:** when a phone opens that agent's chat and the video is in its window, not when the card scrolls into view, so it's usually ready by the time the user gets there. One conversion at a time, cached. The card shows "getting it ready" while converting and "on its way" while the pieces travel. Nothing is converted while no phone is watching.
- **What 8 MB means:** the size of the converted video file. On the wire it costs more: sealed, then base64'd once (about 1.35 times; don't base64 the bytes twice). Pieces are sized and paced so that no more than about 3 MB of one transfer sits in the phone's mailbox at a time.

## Left to the builder

- The exact message format and the request and reply message types on the phone bridge, as long as the old phone build (8) keeps working with the new Mac and vice versa. A build without media support should just see text, as today.
- How video file paths are found in tool calls and text, and how false positives are kept out.
- Piece size, how many pieces are in flight, and retries, staying well under the 2 MB request limit and the 8 MB mailbox.
- Where the Mac caches converted videos and resized images (under `~/.synapse`), and when it cleans them up.
- Whether to send a small first-frame thumbnail for videos before the full copy.
- Tests: the parsers for both agents, using the real transcript shapes above; the bridge's request, piece and acknowledgement flow, against the local cloud fixture (`app/tests/cloud-fixture.mjs`); the phone's parsing and cache logic in plain Node where possible.
