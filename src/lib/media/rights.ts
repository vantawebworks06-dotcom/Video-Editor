import type { RightsStatus } from "@/lib/domain/types";

export interface RightsAssessment {
  status: RightsStatus;
  attributionRequired: boolean;
  notes: string[];
}

/**
 * Classify a free-text licence (name and/or URL) into a rights status.
 * Deliberately conservative: anything not positively recognised is UNKNOWN.
 */
export function classifyLicense(license: string | null | undefined, licenseUrl?: string | null): RightsAssessment {
  const l = `${license ?? ""} ${licenseUrl ?? ""}`.toLowerCase();

  if (!l.trim()) {
    return { status: "UNKNOWN", attributionRequired: false, notes: ["No licence information was provided by the source."] };
  }
  if (/non-?free|fair use|all rights reserved|copyrighted|\bnc\b|noncommercial|non-commercial|by-nc|\bnd\b|by-nd|noderivs/.test(l)) {
    return {
      status: "RESTRICTED",
      attributionRequired: true,
      notes: ["Licence restricts commercial use, derivatives, or is not a free licence."],
    };
  }
  if (/public ?domain|publicdomain|\bpd\b|pd-|cc0|zero\/1\.0|no known copyright/.test(l)) {
    return { status: "CLEAR", attributionRequired: false, notes: ["Public domain / CC0."] };
  }
  if (/by-sa|share ?alike|sharealike/.test(l)) {
    return {
      status: "ATTRIBUTION_REQUIRED",
      attributionRequired: true,
      notes: ["Attribution required. Share-alike: adaptations may need to be released under the same licence."],
    };
  }
  if (/cc[- ]?by|creativecommons\.org\/licenses\/by\/|attribution|gfdl|free art/.test(l)) {
    return { status: "ATTRIBUTION_REQUIRED", attributionRequired: true, notes: ["Attribution required."] };
  }
  return { status: "UNKNOWN", attributionRequired: false, notes: [`Unrecognised licence: ${license ?? licenseUrl}`] };
}

const AI_SIGNALS =
  /\b(ai[- ]?generated|ai[- ]?created|ai[- ]?art|ai[- ]?image|ai[- ]?photo|made with ai|generated (?:by|with|using) (?:an? )?(?:ai|artificial intelligence)|artificial intelligence[- ]generated|generative (?:ai|art)|gen[- ]?ai|text[- ]to[- ](?:image|video)|midjourney|stable[- ]?diffusion|sdxl|dall[- ·]?e|dalle|adobe firefly|leonardo ?ai|google imagen|openai sora|runway ?gen|flux\.?1|neural network generated|deepfake|synthetic image)\b/i;

/**
 * True when an asset's own metadata marks it as AI-generated. DocuCut only uses real
 * footage and photography: flagged assets are excluded from search, replacement and render.
 */
export function looksAiGenerated(a: { title: string; description: string | null; categories: string[]; license?: string }): boolean {
  if (/pd[- ]algorithm/i.test(a.license ?? "")) return true; // Commons licence tag for AI/algorithmic output
  return AI_SIGNALS.test(`${a.title} ${a.description ?? ""} ${a.categories.join(" ")}`);
}

export const RIGHTS_RANK: Record<RightsStatus, number> = {
  CLEAR: 100,
  ATTRIBUTION_REQUIRED: 85,
  USER_REVIEW: 50,
  UNKNOWN: 10,
  RESTRICTED: 0,
};

export const RIGHTS_LABEL: Record<RightsStatus, string> = {
  CLEAR: "Clear",
  ATTRIBUTION_REQUIRED: "Attribution required",
  USER_REVIEW: "Needs review",
  UNKNOWN: "Unknown",
  RESTRICTED: "Restricted",
};
