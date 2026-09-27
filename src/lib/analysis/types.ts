/**
 * Transcript analysis: the narration broken into sentences and scenes, what each sentence talks
 * about, and the "visual intent" — what kind of supporting material would strengthen it. Stored on
 * `projects.analysis`; recomputed when the transcript changes.
 */

/** Categories of project media (also the Media Library tabs). */
export const MEDIA_CATEGORIES = ["video", "photo", "social", "article", "screenshot", "interview", "audio", "music", "document", "web"] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];

export type MentionKind =
  | "person"
  | "organization"
  | "place"
  | "event"
  | "date"
  | "song"
  | "album"
  | "work"
  | "platform"
  | "statistic"
  | "quote"
  | "term";

export interface Mention {
  text: string;
  kind: MentionKind;
  /** Canonical name after entity linking ("Vybz Kartel" for "Kartel"). */
  name: string;
  /** Short description from Wikipedia when linked ("Jamaican deejay"). */
  description?: string | null;
  wikiTitle?: string | null;
}

export interface DateMention {
  text: string;
  year: number | null;
  /** ISO date when the day is known. */
  iso: string | null;
  /** "absolute" (1998, January 4 2011), "decade" (the 1990s), "relative" (three years later). */
  kind: "absolute" | "decade" | "relative";
}

export interface Statistic {
  text: string;
  value: number;
  unit: string | null;
}

/** Things the sentence refers to that exist as media somewhere (an interview, a post, a document…). */
export type Reference =
  | "interview"
  | "video"
  | "photo"
  | "document"
  | "news"
  | "social"
  | "performance"
  | "song"
  | "album"
  | "conflict"
  | "legal"
  | "announcement"
  | "product"
  | "science"
  | "sports"
  | "geography"
  | "historical"
  | "emotional";

export type IntentType =
  | "quote"
  | "interview_reference"
  | "social_reaction"
  | "statistic"
  | "document_evidence"
  | "news_event"
  | "legal_event"
  | "time_jump"
  | "performance"
  | "music_reference"
  | "conflict"
  | "product_announcement"
  | "location"
  | "person_intro"
  | "historical_context"
  | "event"
  | "science_explanation"
  | "sports_moment"
  | "emotional"
  | "explanation";

/** One kind of material the editor could look for, and where. */
export interface AssetSuggestion {
  /** Human wording, e.g. "archival photographs of Vybz Kartel". */
  label: string;
  category: MediaCategory;
  /** Research providers worth querying for it (ids from research/providers). */
  providers: string[];
  query: string;
  why: string;
}

/** A moment better told with a designed graphic than with ordinary text. */
export interface GraphicOpportunity {
  kind: "year" | "time_jump" | "location" | "statistic" | "date_event" | "quote" | "name" | "headline";
  text: string;
  sub: string | null;
}

export interface VisualIntent {
  type: IntentType;
  entities: string[];
  topics: string[];
  suggestedAssets: AssetSuggestion[];
  graphic: GraphicOpportunity | null;
  /** 0-1: how much this line deserves strong visual support. */
  importance: number;
  tone: "neutral" | "serious" | "tense" | "somber" | "light" | "uplifting" | "dramatic";
  era: string | null;
  /** How the intent was derived. The rule-based engine is always labelled as such. */
  basis: "rules" | "claude";
  /** 0-1: confidence of the classification — not of any factual claim. */
  confidence: number;
  reasons: string[];
}

export interface SentenceAnalysis {
  idx: number;
  text: string;
  start: number;
  end: number;
  /** Index into `scenes`. */
  scene: number;
  mentions: Mention[];
  dates: DateMention[];
  statistics: Statistic[];
  quotes: string[];
  /** A factual claim that should be backed by a source in the evidence panel. */
  claim: { kind: "factual" | "allegation" | "statistic" | "attribution"; text: string } | null;
  references: Reference[];
  intent: VisualIntent;
}

export interface SceneSummary {
  idx: number;
  /** The generated edit's scene id when an edit exists ("scene_004"), else "script_<n>". */
  key: string;
  start: number;
  end: number;
  sentences: [number, number]; // [first, last] inclusive
  title: string;
  entities: string[];
  topics: string[];
}

export interface GlobalEntity {
  name: string;
  kind: MentionKind;
  description: string | null;
  wikiTitle: string | null;
  mentions: number;
  firstSentence: number;
}

export interface TranscriptAnalysis {
  version: 1;
  basis: "rules" | "claude";
  createdAt: string;
  /** Hash of the transcript/script text + topic it was computed from. */
  sourceHash: string;
  /** false when times are estimated from the script (no narration transcript yet). */
  timed: boolean;
  topic: string;
  country: string | null;
  sentences: SentenceAnalysis[];
  scenes: SceneSummary[];
  entities: GlobalEntity[];
  /** Entity linking needs Wikipedia; when it failed the analysis says so. */
  warnings: string[];
}
