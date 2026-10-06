// CC0: Trailing the Twinkling Tunnelwisp
//  A bit of Saturday coding (also Norway's Constitution Day).
//  Some artifacts remain, but it's good enough for my standards.
//
//  Music by Pestis created for Cassini's Cosmic Conclusion
//   https://demozoo.org/productions/367582/
//
//  Original (CC0) Shadertoy: https://www.shadertoy.com/view/WfcGWj
//
// Ported verbatim to GLSL ES 1.00 (our playground is WebGL1, the original
// is WebGL2/ES 3.00). The ONLY changes are dialect-level and do not alter
// the image: locals are zero-initialized, the golfed comma-operator
// for-loop is expanded into an equivalent explicit loop (identical math,
// identical order), and tanh() — absent in ES 1.00 — is provided by the
// tanh4() helper below. Everything else is the original code.

// Distance field for gyroid, adapted from Paul Karlik's "Gyroid Travel"
// in KodeLife. Tweaked slightly for this effect.
float g(vec4 p, float s) {
  // p.x=-abs(p.x);  // Makes it nicer (IMO) but costs bytes!
  return abs(dot(sin(p *= s), cos(p.zxwy)) - 1.) / s;
}

// tanh is a GLSL ES 3.00 builtin; emulate it for ES 1.00. Input is clamped
// so exp() can't overflow to Inf (which would yield NaN); tanh saturates
// well before |x|=15 so the clamp is invisible in the output.
vec4 tanh4(vec4 x) {
  x = clamp(x, -15., 15.);
  vec4 e = exp(2. * x);
  return (e - 1.) / (e + 1.);
}

void mainImage(out vec4 O, vec2 C) {
  float i = 0., d = 0., z = 0., s = 0., T = iTime;
  vec4 o = vec4(0.), q = vec4(0.), p = vec4(0.), U = vec4(2, 1, 0, 3);
  vec2 r = iResolution.xy;

  // Step through the scene, up to 78 steps. (Original used a single golfed
  // for-loop with all of the following packed into its comma-separated
  // increment clause; expanded here for ES 1.00 — same computation.)
  for (int n = 0; n < 78; n++) {
    // Accumulate glow — brighter and sharper if not mirrored (above axis).
    o += (s > 0. ? 1. : .1) * p.w * p / max(s > 0. ? d : d * d * d, 5E-4);

    // Advance along the ray by current distance estimate (+ epsilon).
    // The epsilon makes the cave walls somewhat translucent.
    z += d + 5E-4;
    // Compute ray direction, scaled by distance.
    q = vec4(normalize(vec3(C - .5 * r, r.y)) * z, .2);
    // Traverse through the cave.
    q.z += T / 3E1;
    // Save sign before mirroring.
    s = q.y + .1;
    // Creates the water reflection effect.
    q.y = abs(s);
    p = q;
    p.y -= .11;
    // Twist cave walls based on depth — the rotation matrix
    //   mat2(cos(a), sin(a), -sin(a), cos(a)) is approximated with
    //   mat2(cos(a + vec4(0,11,33,0))).
    p.xy *= mat2(cos(11. * U.zywz - 2. * p.z));
    p.y -= .2;
    // Combine gyroid fields at two scales for more detail.
    d = abs(g(p, 8.) - g(p, 24.)) / 4.;
    // Base glow color varies with distance from center.
    p = 1. + cos(.7 * U + 5. * q.z);
  }

  // Add pulsing glow for the "tunnelwisp".
  o += (1.4 + sin(T) * sin(1.7 * T) * sin(2.3 * T))
       * 1E3 * U / length(q.xy);

  // Apply tanh for soft tone mapping.
  O = tanh4(o / 1E5);
}
