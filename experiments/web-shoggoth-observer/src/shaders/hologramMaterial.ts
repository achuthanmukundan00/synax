import * as THREE from "three";

// ─── Holographic / glass material ───────────────────────────────────────
// Thin luminous surfaces with fresnel-like edge glow

export const hologramVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const hologramFragmentShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  uniform vec3 uColor;
  uniform vec3 uEdgeColor;
  uniform float uOpacity;
  uniform float uEdgeStrength;
  uniform float uTime;
  uniform float uPulse;
  uniform vec3 uCameraPosition;

  void main() {
    vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
    float fresnel = 1.0 - abs(dot(viewDir, vNormal));
    fresnel = pow(fresnel, uEdgeStrength);

    // Subtle scanline
    float scanline = sin(vWorldPosition.y * 60.0 + uTime * 2.0) * 0.5 + 0.5;
    scanline = 0.9 + scanline * 0.1;

    // Pulse glow
    float pulse = 0.85 + uPulse * 0.15;

    vec3 baseColor = uColor * scanline * pulse;
    vec3 edgeGlow = uEdgeColor * fresnel * 1.5;

    float alpha = uOpacity * (0.3 + fresnel * 0.7);
    vec3 finalColor = baseColor + edgeGlow;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

// ─── Beam / energy arc material ─────────────────────────────────────────
// For attention arcs, tool beams, expert routing beams

export const beamVertexShader = /* glsl */ `
  attribute float aProgress;
  attribute float aIntensity;
  varying float vProgress;
  varying float vIntensity;

  void main() {
    vProgress = aProgress;
    vIntensity = aIntensity;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const beamFragmentShader = /* glsl */ `
  varying float vProgress;
  varying float vIntensity;

  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;

  void main() {
    // Traveling energy pulse
    float pulse = sin(vProgress * 20.0 - uTime * 5.0) * 0.5 + 0.5;
    float fadeIn = smoothstep(0.0, 0.1, vProgress);
    float fadeOut = 1.0 - smoothstep(0.7, 1.0, vProgress);
    float alpha = uOpacity * vIntensity * pulse * fadeIn * fadeOut * 0.9;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

// ─── Instanced glow material ────────────────────────────────────────────
// For expert shards, compute cells, token particles

export const instancedGlowVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vInstanceId;

  void main() {
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vPosition = mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const instancedGlowFragmentShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vPosition;

  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uGlowIntensity;
  uniform float uTime;
  uniform vec3 uCameraPosition;

  void main() {
    vec3 viewDir = normalize(-vPosition);
    float fresnel = 1.0 - abs(dot(viewDir, vNormal));
    fresnel = pow(fresnel, 2.5);

    float pulse = 0.9 + sin(uTime * 3.0) * 0.1;
    vec3 glow = uColor * (1.0 + fresnel * uGlowIntensity) * pulse;
    float alpha = uOpacity * (0.6 + fresnel * 0.4);

    gl_FragColor = vec4(glow, alpha);
  }
`;

// ─── Factory functions ──────────────────────────────────────────────────

export function createHologramMaterial(color: string, edgeColor: string, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: hologramVertexShader,
    fragmentShader: hologramFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uEdgeColor: { value: new THREE.Color(edgeColor) },
      uOpacity: { value: opacity },
      uEdgeStrength: { value: 2.5 },
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uCameraPosition: { value: new THREE.Vector3() },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

export function createBeamMaterial(color: string, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: beamVertexShader,
    fragmentShader: beamFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function createInstancedGlowMaterial(color: string, opacity: number, glowIntensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: instancedGlowVertexShader,
    fragmentShader: instancedGlowFragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uGlowIntensity: { value: glowIntensity },
      uTime: { value: 0 },
      uCameraPosition: { value: new THREE.Vector3() },
    },
    transparent: true,
    depthWrite: true,
    blending: THREE.NormalBlending,
  });
}

// ─── Update shader time ─────────────────────────────────────────────────

export function updateShaderTime(material: THREE.ShaderMaterial, time: number, pulse: number = 0): void {
  if (material.uniforms.uTime) material.uniforms.uTime.value = time;
  if (material.uniforms.uPulse !== undefined) material.uniforms.uPulse.value = pulse;
}
