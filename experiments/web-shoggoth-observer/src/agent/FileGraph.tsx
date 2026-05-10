import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntimeStore } from "../runtimeStore";
import { RUNTIME_COLORS } from "../eventTypes";
import type { FileNode } from "../eventTypes";

/**
 * Small orbiting graph of files around the morphology.
 * Read files glow blue, edited files glow amber,
 * deleted files flash red, test files violet, spec/docs pale green.
 *
 * Uses persistent refs — creates meshes once per file, only updates
 * transforms in useFrame. No per-frame destruction.
 */
const FileGraph: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const files = useRuntimeStore((s) => s.files);

  const nodeGeo = useMemo(() => new THREE.BoxGeometry(0.04, 0.06, 0.02), []);
  const orbitRadius = 2.1;

  // Persistent mesh entries keyed by path
  const entriesRef = useRef<Map<string, { mesh: THREE.Mesh; beam?: THREE.Mesh; mat: THREE.MeshStandardMaterial; beamMat?: THREE.MeshBasicMaterial; activity: string; kind: string }>>(new Map());

  useFrame((state) => {
    const grp = groupRef.current;
    if (!grp) return;
    const t = state.clock.elapsedTime;

    // ── Derive current file nodes ────────────────────────────────────────
    const nodes: FileNode[] = [];
    const seen = new Set<string>();
    for (const path of files.activeReads) {
      if (!seen.has(path)) { seen.add(path); nodes.push({ path, kind: classifyFile(path), lastTouchedAt: Date.now(), activity: "read" }); }
    }
    for (const path of files.activeWrites) {
      if (!seen.has(path)) { seen.add(path); nodes.push({ path, kind: classifyFile(path), lastTouchedAt: Date.now(), activity: "write" }); }
    }
    if (files.lastEdited && !seen.has(files.lastEdited)) {
      nodes.push({ path: files.lastEdited, kind: classifyFile(files.lastEdited), lastTouchedAt: Date.now(), activity: "edit" });
    }
    const currentPaths = new Set(nodes.map(n => n.path));

    // ── Remove stale entries ─────────────────────────────────────────────
    for (const [path, entry] of entriesRef.current) {
      if (!currentPaths.has(path)) {
        grp.remove(entry.mesh);
        if (entry.beam) { grp.remove(entry.beam); entry.beamMat!.dispose(); }
        entry.mat.dispose();
        entriesRef.current.delete(path);
      }
    }

    // ── Add new entries ──────────────────────────────────────────────────
    for (const node of nodes) {
      if (entriesRef.current.has(node.path)) continue;
      const color = colorForActivity(node.activity, node.kind);
      const mat = new THREE.MeshStandardMaterial({
        color, emissive: color,
        emissiveIntensity: node.activity === "write" || node.activity === "edit" ? 0.6 : 0.3,
        roughness: 0.3, metalness: 0.5,
      });
      const mesh = new THREE.Mesh(nodeGeo, mat);
      grp.add(mesh);

      let beam: THREE.Mesh | undefined;
      let beamMat: THREE.MeshBasicMaterial | undefined;
      if (node.activity === "read" || node.activity === "write" || node.activity === "edit") {
        beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending });
        beam = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 6), beamMat);
        grp.add(beam);
      }

      entriesRef.current.set(node.path, { mesh, beam, mat, beamMat, activity: node.activity, kind: node.kind });
    }

    // ── Update positions each frame ──────────────────────────────────────
    const n = nodes.length || 1;
    nodes.forEach((node, i) => {
      const entry = entriesRef.current.get(node.path);
      if (!entry) return;
      const angle = (i / n) * Math.PI * 2 + t * 0.15;
      const x = Math.cos(angle) * orbitRadius;
      const z = Math.sin(angle) * orbitRadius;
      const y = Math.sin(angle * 2 + i) * 0.4;
      entry.mesh.position.set(x, y, z);
      entry.mesh.lookAt(new THREE.Vector3(x * 2, y * 2, z * 2));

      if (entry.beam) {
        const midX = x * 0.5, midY = y * 0.5, midZ = z * 0.5;
        const dist = Math.sqrt(x * x + y * y + z * z);
        entry.beam.position.set(midX, midY, midZ);
        entry.beam.lookAt(new THREE.Vector3(x, y, z));
        entry.beam.rotateX(Math.PI / 2);
        entry.beam.scale.y = dist;
      }
    });
  });

  return <group ref={groupRef} />;
};

function colorForActivity(activity: string, kind: string): string {
  if (kind === "test") return RUNTIME_COLORS.verification;
  if (kind === "spec") return "#4ade80";
  switch (activity) {
    case "read": return RUNTIME_COLORS.toolRead;
    case "write": case "edit": return RUNTIME_COLORS.toolWrite;
    case "delete": return RUNTIME_COLORS.suspicious;
    default: return RUNTIME_COLORS.kvCache;
  }
}

function classifyFile(path: string): FileNode["kind"] {
  if (/\.test\.|\.spec\.|__tests__|\.test\.ts|\.spec\.ts/.test(path)) return "test";
  if (/spec\//.test(path) || /\.md$/.test(path)) return "spec";
  if (/\.config\.|\.toml$|\.yaml$|\.json$/.test(path)) return "config";
  if (/\.ts$|\.tsx$|\.js$|\.jsx$|\.py$|\.rs$|\.go$/.test(path)) return "source";
  return "unknown";
}

export default FileGraph;
