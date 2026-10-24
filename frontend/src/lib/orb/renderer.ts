/**
 * The LifeOS orb: a small, dependency-free WebGL 1 scene (lazy-loaded). A lit icosphere whose surface is displaced by
 * 3D simplex noise, "filled" from below to the current progress, with an orbiting ring of particles that light up with
 * progress. Pointer drag rotates it with inertia; arrow keys nudge it; a tap sends a pulse through the surface.
 *
 * Performance budget: ≤ 2,562 vertices (≤ 642 on touch devices), device-pixel ratio capped at 1.75 (1.5 on touch),
 * one draw call per mesh, rendering paused when off-screen or the tab is hidden, and no animation loop at all when the
 * user prefers reduced motion (frames are drawn only on input or prop changes). An adaptive governor watches frame
 * times: if the page drops below ~40 fps it first lowers resolution and mesh detail, and if it is still slow it stops
 * the continuous animation (the orb stays 3D and interactive, drawing only on input) so the rest of the app stays smooth.
 */
import { hexToRgb, icosphere, normalMatrix, perspective, ring, rotation, translation } from './geometry'

export type OrbMode = 'idle' | 'focus' | 'paused' | 'thinking' | 'celebrate'
export type OrbState = { progress: number; mode: OrbMode; palette: [string, string, string]; dark: boolean }
export type OrbHandle = { update: (state: Partial<OrbState>) => void; nudge: (dx: number, dy: number) => void; pulse: () => void; destroy: () => void }

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`

// Uniforms shared by both stages (uTime) declare the same explicit precision: GLSL ES links fail otherwise.
const SPHERE_VS = `
attribute vec3 aPosition;
uniform mat4 uProjection; uniform mat4 uView; uniform mat4 uModel; uniform mat3 uNormal;
uniform mediump float uTime; uniform float uAmp; uniform float uFreq;
varying vec3 vNormal; varying vec3 vViewPos; varying vec3 vObject; varying float vNoise;
${NOISE}
vec3 displaced(vec3 p){ return p*(1.0+uAmp*snoise(p*uFreq+vec3(0.0,uTime*0.35,uTime*0.2))); }
void main(){
  vec3 p=displaced(aPosition);
  // Normal from finite differences along two tangents, so lighting follows the displaced surface.
  vec3 t1=normalize(cross(aPosition,abs(aPosition.y)<0.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0)));
  vec3 t2=normalize(cross(aPosition,t1));
  vec3 n=normalize(cross(displaced(normalize(aPosition+t1*0.02))-p,displaced(normalize(aPosition+t2*0.02))-p));
  if(dot(n,aPosition)<0.0) n=-n;
  vec4 view=uView*uModel*vec4(p,1.0);
  vNormal=normalize(uNormal*n); vViewPos=view.xyz; vObject=aPosition; vNoise=snoise(aPosition*2.0+uTime*0.15);
  gl_Position=uProjection*view;
}`

const SPHERE_FS = `
precision mediump float;
uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uColorC; uniform float uProgress; uniform mediump float uTime; uniform float uDark;
varying vec3 vNormal; varying vec3 vViewPos; varying vec3 vObject; varying float vNoise;
void main(){
  vec3 n=normalize(vNormal); vec3 v=normalize(-vViewPos);
  vec3 light=normalize(vec3(-0.45,0.75,0.55));
  float diff=max(dot(n,light),0.0);
  float spec=pow(max(dot(n,normalize(light+v)),0.0),48.0);
  float fres=pow(1.0-max(dot(n,v),0.0),2.4);
  // Liquid fill: the surface below the progress level glows in the accent colour, with a gently moving meniscus.
  float level=uProgress*2.0-1.0+0.04*sin(vObject.x*6.0+uTime*1.3)+0.03*vNoise;
  float filled=smoothstep(level+0.035,level-0.035,vObject.y)*step(0.001,uProgress);
  vec3 base=mix(uColorA,uColorC,0.5+0.5*vObject.y);
  vec3 col=mix(base,uColorB,filled*0.85);
  col*=0.42+0.68*diff;
  col+=spec*mix(0.55,0.8,uDark);
  col+=fres*mix(uColorB,uColorC,0.5)*mix(0.7,1.1,uDark);
  float alpha=clamp(0.9+fres*0.1,0.0,1.0);
  gl_FragColor=vec4(col*alpha,alpha);
}`

const POINTS_VS = `
attribute vec4 aPoint;
uniform mat4 uProjection; uniform mat4 uView; uniform mat4 uRing; uniform float uSize; uniform float uProgress; uniform float uTime;
varying float vLit; varying float vFade;
void main(){
  vec4 view=uView*uRing*vec4(aPoint.xyz,1.0);
  vLit=step(aPoint.w,uProgress-0.0001);
  vFade=0.55+0.45*sin(uTime*1.6+aPoint.w*40.0);
  gl_PointSize=uSize*(vLit>0.5?1.0:0.6)*(2.6/-view.z);
  gl_Position=uProjection*view;
}`

const POINTS_FS = `
precision mediump float;
uniform vec3 uColorLit; uniform vec3 uColorDim;
varying float vLit; varying float vFade;
void main(){
  vec2 c=gl_PointCoord-0.5; float d=length(c);
  float a=smoothstep(0.5,0.1,d)*(vLit>0.5?vFade:0.35);
  vec3 col=mix(uColorDim,uColorLit,vLit);
  gl_FragColor=vec4(col*a,a);
}`

const MODES: Record<OrbMode, { amp: number; freq: number; speed: number; spin: number }> = {
  idle: { amp: 0.075, freq: 1.6, speed: 0.6, spin: 0.12 },
  focus: { amp: 0.05, freq: 1.3, speed: 0.35, spin: 0.06 },
  paused: { amp: 0.025, freq: 1.2, speed: 0.08, spin: 0.0 },
  thinking: { amp: 0.14, freq: 2.2, speed: 1.6, spin: 0.35 },
  celebrate: { amp: 0.11, freq: 1.9, speed: 1.0, spin: 0.5 },
}

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link')
  return program
}

/** True when this browser can create a WebGL context (checked without touching the DOM canvas used for rendering). */
export function webglAvailable(): boolean {
  if (typeof window === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false
  try { return !!document.createElement('canvas').getContext('webgl') } catch { return false }
}

/**
 * Start the orb on a canvas. Returns null when WebGL is unavailable or fails, so callers can keep the CSS fallback.
 */
export function createOrb(canvas: HTMLCanvasElement, initial: OrbState, options: { reducedMotion: boolean; onLost?: () => void }): OrbHandle | null {
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' })
  if (!gl) return null
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false
  let sphere: WebGLProgram, points: WebGLProgram
  try {
    sphere = compile(gl, SPHERE_VS, SPHERE_FS)
    points = compile(gl, POINTS_VS, POINTS_FS)
  } catch (e) {
    console.warn('LifeOS orb: using the static fallback —', (e as Error).message)
    return null
  }
  let mesh = icosphere(coarse ? 3 : 4)
  const vbo = gl.createBuffer(), ibo = gl.createBuffer(), pbo = gl.createBuffer()
  const uploadMesh = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
  }
  uploadMesh()
  const particles = ring(coarse ? 48 : 72, 1.62)
  gl.bindBuffer(gl.ARRAY_BUFFER, pbo); gl.bufferData(gl.ARRAY_BUFFER, particles, gl.STATIC_DRAW)
  const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name)
  const aPosition = gl.getAttribLocation(sphere, 'aPosition'), aPoint = gl.getAttribLocation(points, 'aPoint')

  let state = { ...initial }
  let yaw = 0.4, pitch = -0.25, vYaw = 0, vPitch = 0, pulse = 0, time = 0, last = performance.now(), frame = 0, visible = true, destroyed = false, dragging = false
  let lx = 0, ly = 0, py = 0, amp = MODES[state.mode].amp
  // Adaptive quality: 0 = full, 1 = reduced resolution + mesh, 2 = no continuous loop (draw on input only).
  let quality = 0, frameAvg = 1 / 60, sampled = 0
  let still = options.reducedMotion

  function resize() {
    const dpr = quality > 0 ? 1 : Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 1.75)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    gl!.viewport(0, 0, w, h)
  }

  function draw() {
    if (destroyed) return
    resize()
    const mode = MODES[state.mode]
    amp += (mode.amp + pulse * 0.18 - amp) * 0.08
    const [a, b, c] = state.palette.map(hexToRgb)
    const breathe = state.mode === 'focus' && !options.reducedMotion ? 1 + 0.035 * Math.sin(time * (Math.PI * 2 / 8)) : 1
    const projection = perspective(0.62, canvas.width / canvas.height, 0.1, 20)
    const view = translation(0, 0, -5.4)
    const model = rotation(pitch, yaw, breathe)
    gl!.clearColor(0, 0, 0, 0)
    gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT)
    gl!.enable(gl!.DEPTH_TEST)
    gl!.enable(gl!.BLEND)
    gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA)

    gl!.useProgram(sphere)
    gl!.uniformMatrix4fv(u(sphere, 'uProjection'), false, projection)
    gl!.uniformMatrix4fv(u(sphere, 'uView'), false, view)
    gl!.uniformMatrix4fv(u(sphere, 'uModel'), false, model)
    gl!.uniformMatrix3fv(u(sphere, 'uNormal'), false, normalMatrix(model))
    gl!.uniform1f(u(sphere, 'uTime'), time * mode.speed)
    gl!.uniform1f(u(sphere, 'uAmp'), amp)
    gl!.uniform1f(u(sphere, 'uFreq'), mode.freq)
    gl!.uniform3fv(u(sphere, 'uColorA'), a)
    gl!.uniform3fv(u(sphere, 'uColorB'), b)
    gl!.uniform3fv(u(sphere, 'uColorC'), c)
    gl!.uniform1f(u(sphere, 'uProgress'), Math.max(0, Math.min(1, state.progress)))
    gl!.uniform1f(u(sphere, 'uDark'), state.dark ? 1 : 0)
    gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo)
    gl!.enableVertexAttribArray(aPosition)
    gl!.vertexAttribPointer(aPosition, 3, gl!.FLOAT, false, 0, 0)
    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, ibo)
    gl!.drawElements(gl!.TRIANGLES, mesh.indices.length, gl!.UNSIGNED_SHORT, 0)
    gl!.disableVertexAttribArray(aPosition)

    gl!.depthMask(false)
    gl!.useProgram(points)
    gl!.uniformMatrix4fv(u(points, 'uProjection'), false, projection)
    gl!.uniformMatrix4fv(u(points, 'uView'), false, view)
    gl!.uniformMatrix4fv(u(points, 'uRing'), false, rotation(0.42, time * 0.15))
    gl!.uniform1f(u(points, 'uSize'), 7 * Math.min(window.devicePixelRatio || 1, 1.75))
    gl!.uniform1f(u(points, 'uProgress'), Math.max(0, Math.min(1, state.progress)))
    gl!.uniform1f(u(points, 'uTime'), time)
    gl!.uniform3fv(u(points, 'uColorLit'), b)
    gl!.uniform3fv(u(points, 'uColorDim'), state.dark ? [0.55, 0.6, 0.75] : [0.6, 0.64, 0.75])
    gl!.bindBuffer(gl!.ARRAY_BUFFER, pbo)
    gl!.enableVertexAttribArray(aPoint)
    gl!.vertexAttribPointer(aPoint, 4, gl!.FLOAT, false, 0, 0)
    gl!.drawArrays(gl!.POINTS, 0, particles.length / 4)
    gl!.disableVertexAttribArray(aPoint)
    gl!.depthMask(true)
  }

  function tick(now: number) {
    frame = 0
    const raw = (now - last) / 1000
    const dt = Math.min(0.05, raw)
    last = now
    if (raw < 0.5) { frameAvg += (raw - frameAvg) * 0.05; sampled++ }
    if (sampled > 45 && frameAvg > 1 / 40 && quality < 2) {
      quality++
      sampled = 0
      frameAvg = 1 / 60
      if (quality === 1) { mesh = icosphere(3); uploadMesh() } else { still = true }
    }
    time += dt
    const mode = MODES[state.mode]
    if (!dragging) {
      yaw += vYaw + mode.spin * dt
      pitch += vPitch
      vYaw *= 0.94; vPitch *= 0.94
      pitch += (-0.25 + py * 0.25 - pitch) * 0.02
    }
    pulse *= 0.95
    draw()
    schedule()
  }

  function schedule() {
    if (!still && visible && !document.hidden && !frame && !destroyed) frame = requestAnimationFrame(tick)
  }
  /** With reduced motion there is no loop: settle input changes in a few frames, then stop. */
  function redraw() {
    if (still) { pulse = 0; amp = MODES[state.mode].amp; draw() } else schedule()
  }

  const onPointerDown = (e: PointerEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture?.(e.pointerId) }
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    if (dragging) {
      const dx = (e.clientX - lx) / rect.width, dy = (e.clientY - ly) / rect.height
      lx = e.clientX; ly = e.clientY
      vYaw = dx * 2.4; yaw += vYaw; pitch = Math.max(-1.1, Math.min(1.1, pitch + dy * 2.4)); vPitch = 0
      redraw()
    } else {
      py = ((e.clientY - rect.top) / rect.height - 0.5) * -1
    }
  }
  const onPointerUp = () => { dragging = false }
  const onVisibility = () => { if (!document.hidden) { last = performance.now(); schedule() } }
  const onLost = (e: Event) => { e.preventDefault(); destroyed = true; options.onLost?.() }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  document.addEventListener('visibilitychange', onVisibility)
  canvas.addEventListener('webglcontextlost', onLost)
  const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) { last = performance.now(); schedule() } }) : null
  observer?.observe(canvas)
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => redraw()) : null
  resizeObserver?.observe(canvas)

  draw()
  schedule()

  return {
    update(next) { state = { ...state, ...next }; redraw() },
    nudge(dx, dy) { vYaw += dx; vPitch += dy; if (still) { yaw += dx * 6; pitch = Math.max(-1.1, Math.min(1.1, pitch + dy * 6)) } redraw() },
    pulse() { pulse = 1; redraw() },
    destroy() {
      destroyed = true
      if (frame) cancelAnimationFrame(frame)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onLost)
      observer?.disconnect()
      resizeObserver?.disconnect()
      gl!.deleteBuffer(vbo); gl!.deleteBuffer(ibo); gl!.deleteBuffer(pbo)
      gl!.deleteProgram(sphere); gl!.deleteProgram(points)
    },
  }
}
