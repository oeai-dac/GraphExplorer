/** True if a value is a plain http(s) URL -- the generic signal that a table
    cell was a link, without needing per-column configuration in the Studio. */
export function isUrl(value) {
  const s = String(value ?? '').trim()
  return s.startsWith('http://') || s.startsWith('https://')
}

// Image file extensions we can embed directly. A trailing query string or
// fragment (e.g. "?w=800", "#page=2") is tolerated so signed/CDN URLs still
// match. Kept deliberately narrow to formats browsers render as <img>.
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)(?:[?#].*)?$/i

// Some endpoints encode the media type as a PATH SEGMENT rather than a file
// extension, e.g. "https://host/.../image/jpeg". Recognise an "image/<format>"
// segment (optionally followed by /, ? or #) as an embeddable image too.
const IMAGE_MIME_PATH_RE = /\/image\/(jpe?g|png|gif|webp|avif|svg(?:\+xml)?|bmp|tiff?|x-icon|heic|heif)(?:[/?#]|$)/i

/** True if a value looks like a directly embeddable image: an http(s) URL that
    ends in a known image extension (or carries an "image/<format>" path
    segment), or an inline `data:image/...` URI. This is the zero-config signal
    -- no checkbox in the Studio needed -- so a cell that already holds an image
    URL (public or http://localhost/...) is shown inline automatically. */
export function isImageUrl(value) {
  const s = String(value ?? '').trim()
  if (s.startsWith('data:image/')) return true
  return isUrl(s) && (IMAGE_EXT_RE.test(s) || IMAGE_MIME_PATH_RE.test(s))
}

// Attribute keys that strongly imply their value is an image, so a URL WITHOUT
// a recognisable file extension (e.g. a IIIF/API endpoint) can still be shown
// inline. Matches substrings, case-insensitively, DE + EN.
const IMAGE_KEY_RE = /(bild|foto|photo|image|img|abbildung|grafik|graphic|thumbnail|thumb|scan|ansicht)/i

/** True if an attribute key hints that its value is meant to be an image. Used
    together with isUrl() as a fallback for extensionless image URLs. */
export function isImageKey(key) {
  return IMAGE_KEY_RE.test(String(key ?? ''))
}
