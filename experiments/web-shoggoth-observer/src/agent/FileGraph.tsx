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
 */
const FileGraph: React.FC = () => {
  const groupRef = useRef<THREE.Group>(null);
  const files = useRuntimeStore((s) => s.files);

  // Derive file nodes from active reads/writes/lastEdited
  const fileNodes = useMemo((): FileNode[] => {
    const nodes: FileNode[] = [];
    const seen = new Set<string>();

    for (const path of files.activeReads) {
      if (!seen.has(path)) {
        seen.add(path);
        nodes.push({
          path,
          kind: classifyFile(path),
          lastTouchedAt: Date.now(),
          activity: "read",
        });
      }
    }
    for (const path of files.activeWrites) {
      if (!seen.has(path)) {
        seen.add(path);
        nodes.push({
          path,
          kind: classifyFile(path),
          lastTouchedAt: Date.now(),
          activity: "write",
        });
      }
    }
    if (files.lastEdited && !seen.has(files.lastEdited)) {
      nodes.push({
        path: files.lastEdited,
        kind: classifyFile(files.lastEdited),
        lastTouchedAt: Date.now(),
        activity: "edit",
      });
    }
    return nodes.slice(-12); // Cap visible files
  }, [files]);

  const colorForActivity = (activity: string, kind: string): string => {
    if (kind === "test") return RUNTIME_COLORS.verification;
    if (kind === "spec") return "#4ade80";
    switch (activity) {
      case "read": return RUNTIME_COLORS.toolRead;
      case "write": case "edit": return RUNTIME_COLORS.toolWrite;
      case "delete": return RUNTIME_COLORS.suspicious;
      default: return RUNTIME_COLORS.kvCache;
    }
  };

  const nodeGeo = useMemo(() => new THREE.BoxGeometry(0.04, 0.06, 0.02), []);
  const orbitRadius = 2.1;

  useFrame((state) => {
    if (!groupRef.current) return;
    const t = state.clock.elapsedTime;

    // Clear and rebuild
    const grp = groupRef.current;
    while (grp.children.length > 0) {
      const child = grp.children[0];
      if (child instanceof THREE.Mesh && child.material instanceof THREE.Material) {
        child.material.dispose();
      }
      grp.remove(child);
    }

    const n = fileNodes.length || 0;
    fileNodes.forEach((node, i) => {
      const angle = (i / Math.max(n, 1)) * Math.PI * 2 + t * 0.15;
      const x = Math.cos(angle) * orbitRadius;
      const z = Math.sin(angle) * orbitRadius;
      const y = Math.sin(angle * 2 + i) * 0.4;

      const color = colorForActivity(node.activity, node.kind);
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: node.activity === "write" || node.activity === "edit" ? 0.6 : 0.3,
        roughness: 0.3,
        metalness: 0.5,
      });

      const mesh = new THREE.Mesh(nodeGeo, mat);
      mesh.position.set(x, y, z);
      mesh.lookAt(new THREE.Vector3(x * 2, y * 2, z * 2));

      // Beam to origin on read/write
      if (node.activity === "read" || node.activity === "write" || node.activity === "edit") {
        const beamMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.15,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const midX = x * 0.5, midY = y * 0.5, midZ = z * 0.5;
        const dist = Math.sqrt(x * x + y * y + z * z);
        const beamGeo = new THREE.CylinderGeometry(0.003, 0.003, dist, 6);
        const beam = new THREE.Mesh(beamGeo, beamMat);
        beam.position.set(midX, midY, midZ);
        beam.lookAt(new THREE.Vector3(x, y, z));
        beam.rotateX(Math.PI / 2);
        groupRef.current!.add(beam);
      }

      groupRef.current!.add(mesh);
    });
  });

  return <group ref={groupRef} />;
};

function classifyFile(path: string): FileNode["kind"] {
  if (/\.test\.|\.spec\.|__tests__|\.test\.ts|\.spec\.ts/.test(path)) return "test";
  if (/spec\//.test(path) || /\.md$/.test(path)) return "spec";
  if (/\.config\.|\.toml$|\.yaml$|\.json$/.test(path)) return "config";
  if (/\.ts$|\.tsx$|\.js$|\.jsx$|\.py$|\.rs$|\.go$/.test(path)) return "source";
  return "unknown";
}

export default FileGraph;
