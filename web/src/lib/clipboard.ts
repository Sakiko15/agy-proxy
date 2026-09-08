// Copy-to-clipboard with a non-secure-context fallback: navigator.clipboard
// only exists on https / localhost, so a plain-HTTP LAN deployment would
// otherwise fail silently (the exact bug this helper exists for). The
// hidden-textarea + document.execCommand('copy') path covers those contexts.
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // secure-context write can still reject (lost focus / permission) —
      // fall through to the execCommand path
    }
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('execCommand rejected the copy')
  } finally {
    document.body.removeChild(textarea)
  }
}