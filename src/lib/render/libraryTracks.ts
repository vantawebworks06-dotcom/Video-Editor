// Client-safe list of the generated royalty-safe music beds (see scripts/generate-library.ts).
export const MUSIC_TRACKS = [
  { key: "ambient_pad", name: "Ambient Pad", description: "Soft minor-key pad for documentary narration" },
  { key: "tension_drone", name: "Tension Drone", description: "Low, dark drone for investigative moments" },
  { key: "light_pulse", name: "Light Pulse", description: "Gentle rhythmic pulse for upbeat sections" },
  { key: "dark_pulse", name: "Dark Pulse", description: "Low kick and sub bass for dark, aggressive moments" },
  { key: "suspense_tick", name: "Suspense Tick", description: "Ticking clock over a beating drone for build-ups" },
  { key: "sad_keys", name: "Sad Keys", description: "Slow minor chords for sad or reflective passages" },
  { key: "triumph_rise", name: "Triumph Rise", description: "Bright major chords for triumphant turns" },
  { key: "energy_beat", name: "Energy Beat", description: "100 bpm beat for energetic sections" },
  { key: "mystery_bells", name: "Mystery Bells", description: "Sparse bells over a drone for mysterious moments" },
] as const;
