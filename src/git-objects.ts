// Git object reads share one bounded view. Indexed repositories fetch by ID;
// legacy repositories decode their bounded retained pack set once per view.
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { readObjects, objectLinks, LimitError, IntegrityError, type GitRepository, type GitObject, type GitObjectInfo } from "ntig";

export async function gitObjects(repository: GitRepository) {
  const fallback = repository.getObject && repository.getObjectInfo ? null : await readObjects((await repository.load()).packs);
  return {
    get: async (oid: string): Promise<GitObject | null> => fallback ? fallback.get(oid) ?? null : repository.getObject!(oid),
    info: async (oid: string): Promise<GitObjectInfo | null> => {
      if (!fallback) return repository.getObjectInfo!(oid);
      const object = fallback.get(oid);
      return object ? { oid, type: object.type, size: object.data.length, links: objectLinks(object) } : null;
    },
  };
}

// gitGraph reads only the requested dependency graph, with the same decoded
// byte budget as a received pack. It also serves local GRASP-06 reconciliation.
export async function gitGraph(repository: GitRepository, roots: readonly string[]): Promise<GitObject[]> {
  const reader = await gitObjects(repository);
  const seen = new Map<string, GitObjectInfo["type"]>(), queue = roots.map(oid => ({ oid, type: undefined as GitObjectInfo["type"] | undefined })), result: GitObject[] = [];
  let bytes = 0, edges = 0;
  while (queue.length) {
    const { oid, type } = queue.pop()!;
    if (seen.has(oid)) { if (type && seen.get(oid) !== type) throw new IntegrityError("Git dependency type mismatch"); continue; }
    if (seen.size >= 4096) throw new LimitError("Git graph object limit reached");
    const info = await reader.info(oid);
    if (!info || info.oid !== oid || (type && info.type !== type)) throw new IntegrityError("Git graph dependency is missing");
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > 4 * 1024 * 1024 || bytes + info.size > 16 * 1024 * 1024) throw new LimitError("Git graph byte limit reached");
    bytes += info.size;
    edges += info.links.length;
    if (edges > 65_536) throw new LimitError("Git graph edge limit reached");
    const object = await reader.get(oid);
    if (!object || object.oid !== oid || object.type !== info.type || object.data.length !== info.size) throw new IntegrityError("Git graph changed during read");
    if (bytesToHex(sha1.create().update(new TextEncoder().encode(`${object.type} ${object.data.length}\0`)).update(object.data).digest()) !== oid) throw new IntegrityError("Git object hash mismatch");
    seen.set(oid, info.type);
    result.push(object);
    for (const link of info.links) queue.push(link);
  }
  return result;
}
