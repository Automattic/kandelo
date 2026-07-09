// CC0: Trailing the Twinkling Tunnelwisp
//  A bit of Saturday coding (also Norway's Constitution Day).
//  Some artifacts remain, but it's good enough for my standards.
//
//  Music by Pestis created for Cassini's Cosmic Conclusion
//   https://demozoo.org/productions/367582/
//
//  Original (CC0) Shadertoy: https://www.shadertoy.com/view/WfcGWj
//
// Ported verbatim to GLSL ES 1.00. Dialect-level changes only — the
// synthesis math is unchanged:
//   - Shadertoy's signature is mainSound(int samp, float time); the int
//     sample index is unused here, and our host template calls
//     mainSound(time), so the parameter is dropped.
//   - Locals are zero-initialized (ES 1.00 has no implicit zero-init).
//   - The golfed `for(c=3.;c<4.1;n+=c*=1.02)` inner loop is expanded into
//     an explicit constant-bound loop producing the identical sequence.
//
// NOTE: this composition evolves over minutes, but our sound-shader buffer
// is fixed (~2.73 s) and loops, so only the opening plays, repeating. The
// image is continuously iTime-animated and is unaffected.

vec2 mainSound(in float t) {
  // Accumulator for the final sound output.
  vec2 r = vec2(0.);

  // a controls the overall progression; b is its fractional part.
  for (float i = 1.; i < 4.; i++)
  for (float j = 1.; j < 5.; j++) {
    float a = t * j / 32. + i / 3., b = fract(a);

    // n is the base frequency vector (slight stereo offset); m accumulates
    // harmonics.
    vec2 m = vec2(0.), n = vec2(t, t + 3.) + t / j;

    // Sum sine harmonics with a gradually increasing frequency multiplier
    // and 1/c amplitude falloff. (Original: for(c=3.;c<4.1;n+=c*=1.02).)
    float c = 3.;
    for (int k = 0; k < 16; k++) {
      if (c >= 4.1) break;
      m += sin(n * c) / c;
      c *= 1.02;
      n += c;
    }

    // Only contribute sound during the first part of the composition.
    if (a < 9.)
      r += sin(
             m
             + 4. * sin(t / j / 47.)
               * sin(exp2(mod(a - b, 3.) / 6. + 8.5) * t * j * i + i + j)
           )
           * exp2(-b * 12. - 1. / b + 6. - (i + j) / 3.);
  }

  return r;
}
