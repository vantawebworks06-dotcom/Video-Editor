import type { MemeFrequency, PaperStyle, StyleProfile } from "./types";

export interface StylePreset {
  key: string;
  name: string;
  description: string;
  profile: StyleProfile;
  defaultMemeFrequency: MemeFrequency;
  defaultPaper: PaperStyle;
}

const base: StyleProfile = {
  averageShotDuration: 3.8,
  minShotDuration: 2,
  maxShotDuration: 7,
  photoPercentage: 40,
  videoPercentage: 45,
  archivalPercentage: 20,
  screenshotPercentage: 5,
  textEmphasisFrequency: 0.1,
  memeFrequency: 0.04,
  zoomFrequency: 0.8,
  blackAndWhiteFrequency: 0.05,
  paperLayoutFrequency: 0.2,
  sfxFrequency: 0.3,
  transitionStyle: "mostly_hard_cut",
  visualDensity: "medium",
  preferredStrategies: ["documentary", "cinematic_broll", "photograph_sequence", "mixed_media"],
};

export const STYLE_PRESETS: StylePreset[] = [
  {
    key: "documentary",
    name: "Documentary",
    description: "Balanced B-roll, photographs with slow motion, occasional text. The default.",
    profile: base,
    defaultMemeFrequency: "LOW",
    defaultPaper: "white_paper",
  },
  {
    key: "dancehall_documentary",
    name: "Dancehall Documentary",
    description:
      "Archival-heavy mixed media on paper textures: photographs, screenshots, interviews chopped with B-roll, punch-ins, slow photo moves, hard cuts, occasional memes and large text, with visual density rising at key moments.",
    profile: {
      ...base,
      averageShotDuration: 3.2,
      minShotDuration: 1.6,
      maxShotDuration: 6,
      photoPercentage: 31,
      videoPercentage: 42,
      archivalPercentage: 35,
      screenshotPercentage: 12,
      textEmphasisFrequency: 0.08,
      memeFrequency: 0.06,
      zoomFrequency: 0.85,
      blackAndWhiteFrequency: 0.12,
      paperLayoutFrequency: 0.4,
      sfxFrequency: 0.45,
      transitionStyle: "mostly_hard_cut",
      visualDensity: "high",
      preferredStrategies: ["archival_collage", "mixed_media", "article_breakdown", "evidence_board", "meme_reaction", "interview"],
    },
    defaultMemeFrequency: "MEDIUM",
    defaultPaper: "white_paper",
  },
  {
    key: "historical_documentary",
    name: "Historical Documentary",
    description: "Archival photos and film, timelines, maps, slower pacing, frequent black-and-white.",
    profile: {
      ...base,
      averageShotDuration: 4.8,
      maxShotDuration: 8,
      photoPercentage: 55,
      videoPercentage: 30,
      archivalPercentage: 70,
      blackAndWhiteFrequency: 0.3,
      paperLayoutFrequency: 0.35,
      memeFrequency: 0,
      preferredStrategies: ["historical_timeline", "archival_collage", "photograph_sequence", "map_sequence"],
      visualDensity: "low",
    },
    defaultMemeFrequency: "OFF",
    defaultPaper: "document",
  },
  {
    key: "fast_youtube_essay",
    name: "Fast YouTube Essay",
    description: "Rapid cuts, heavy text emphasis, screenshots and reactions.",
    profile: {
      ...base,
      averageShotDuration: 2.4,
      minShotDuration: 1.2,
      maxShotDuration: 4,
      screenshotPercentage: 15,
      textEmphasisFrequency: 0.25,
      memeFrequency: 0.1,
      sfxFrequency: 0.6,
      visualDensity: "high",
      preferredStrategies: ["mixed_media", "text_emphasis", "screenshot_sequence", "meme_reaction"],
    },
    defaultMemeFrequency: "MEDIUM",
    defaultPaper: "white_paper",
  },
  {
    key: "investigative",
    name: "Investigative",
    description: "Evidence boards, documents, article breakdowns with highlights and circles.",
    profile: {
      ...base,
      averageShotDuration: 3.6,
      screenshotPercentage: 20,
      paperLayoutFrequency: 0.5,
      textEmphasisFrequency: 0.12,
      memeFrequency: 0.02,
      preferredStrategies: ["evidence_board", "article_breakdown", "screenshot_sequence", "documentary"],
    },
    defaultMemeFrequency: "LOW",
    defaultPaper: "corkboard",
  },
  {
    key: "dark_documentary",
    name: "Dark Documentary",
    description: "Moody, slower, desaturated, dark paper, tension risers, no memes.",
    profile: {
      ...base,
      averageShotDuration: 4.6,
      blackAndWhiteFrequency: 0.35,
      memeFrequency: 0,
      sfxFrequency: 0.35,
      transitionStyle: "mixed",
      visualDensity: "low",
      preferredStrategies: ["cinematic_broll", "documentary", "evidence_board"],
    },
    defaultMemeFrequency: "OFF",
    defaultPaper: "dark_paper",
  },
  {
    key: "cinematic",
    name: "Cinematic",
    description: "Long, beautiful B-roll with gentle motion and soft transitions.",
    profile: {
      ...base,
      averageShotDuration: 5.5,
      minShotDuration: 3,
      maxShotDuration: 9,
      photoPercentage: 20,
      videoPercentage: 75,
      paperLayoutFrequency: 0,
      memeFrequency: 0,
      transitionStyle: "mostly_soft",
      visualDensity: "low",
      preferredStrategies: ["cinematic_broll", "documentary"],
    },
    defaultMemeFrequency: "OFF",
    defaultPaper: "white_paper",
  },
  {
    key: "meme_heavy_documentary",
    name: "Meme-heavy Documentary",
    description: "Documentary pacing with frequent reaction interruptions and SFX.",
    profile: {
      ...base,
      averageShotDuration: 2.8,
      memeFrequency: 0.15,
      sfxFrequency: 0.6,
      textEmphasisFrequency: 0.15,
      visualDensity: "high",
      preferredStrategies: ["meme_reaction", "mixed_media", "documentary"],
    },
    defaultMemeFrequency: "HIGH",
    defaultPaper: "white_paper",
  },
];

export function getPreset(key: string): StylePreset {
  return STYLE_PRESETS.find((p) => p.key === key) ?? STYLE_PRESETS[0]!;
}
