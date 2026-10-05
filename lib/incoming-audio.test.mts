import assert from "node:assert/strict";
import {
  getIncomingAudioMediaUrl,
  isIncomingAudioMessage,
} from "./incoming-audio.ts";

assert.equal(isIncomingAudioMessage({ type: "audio" }), true);
assert.equal(isIncomingAudioMessage({ type: "voice" }), true);
assert.equal(isIncomingAudioMessage({ audio: { id: "audio-id" } }), true);
assert.equal(isIncomingAudioMessage({ voice: { id: "voice-id" } }), true);
assert.equal(isIncomingAudioMessage({ type: "text" }), false);
assert.equal(isIncomingAudioMessage(null), false);

assert.equal(
  getIncomingAudioMediaUrl({ audio: { link: " https://example.com/audio.ogg " } }),
  "https://example.com/audio.ogg",
);
assert.equal(
  getIncomingAudioMediaUrl({ voice: { link: "https://example.com/voice.ogg" } }),
  "https://example.com/voice.ogg",
);
assert.equal(getIncomingAudioMediaUrl({ voice: { id: "voice-id" } }), null);

console.log("incoming audio tests passed");
