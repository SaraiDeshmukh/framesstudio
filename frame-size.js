// Frame size helpers (lens width / bridge / temple, in mm). Kept separate from
// glasses-model.js so the catalogue can format sizes without loading the 3D code.

export var SIZE_LIMITS = { eye: [30, 75], bridge: [10, 30], temple: [100, 170] };

// Returns {eye, bridge, temple} with only the plausible numbers kept, or null.
export function cleanSize(size) {
  if (!size) return null;
  var out = {}, any = false;
  ['eye', 'bridge', 'temple'].forEach(function (k) {
    var v = Number(size[k]);
    var lim = SIZE_LIMITS[k];
    if (isFinite(v) && v >= lim[0] && v <= lim[1]) { out[k] = Math.round(v * 10) / 10; any = true; }
    else out[k] = null;
  });
  return any ? out : null;
}

// "52□18 140" style label for whatever is known.
export function sizeLabel(size) {
  var s = cleanSize(size);
  if (!s) return '';
  if (s.eye && s.bridge) return s.eye + '□' + s.bridge + (s.temple ? ' ' + s.temple : '');
  return [s.eye ? 'eye ' + s.eye : '', s.bridge ? 'bridge ' + s.bridge : '', s.temple ? 'temple ' + s.temple : ''].filter(Boolean).join(' · ');
}
