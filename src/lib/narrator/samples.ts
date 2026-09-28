/**
 * Voice samples live at {projectId}/audio/voice-samples/{profileId}/{file}: under the project they
 * were recorded in (storage policies are per project) but in a folder of their own, which project
 * deletion leaves alone, so a profile outlives the project.
 *
 * Profile rows are writable by their owner, so a sample path is only trusted with the service role
 * when it is inside that profile's own folder.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function sampleFolder(projectId: string, profileId: string): string {
  return `${projectId}/audio/voice-samples/${profileId}`;
}

export function isProfileSamplePath(path: string, profileId: string): boolean {
  return new RegExp(`^${UUID}/audio/voice-samples/${profileId.replace(/[^0-9a-f-]/gi, "")}/[A-Za-z0-9._-]{1,120}$`, "i").test(path);
}
