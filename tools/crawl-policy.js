// Normal page viewing only. No guessed URLs, form submission, or vulnerability payloads.
const unsafe = /(?:logout|log-out|signout|sign-out|delete|remove|destroy|unsubscribe|checkout|purchase|payment|approve|reject|reset|cart\/add|action=(?:delete|remove|logout|purchase|approve|reject|reset))/i;
const unsafeLabel = /(?:ログアウト|削除|購入|決済|申請|承認|通知送信|リセット|\b(?:log\s*out|sign\s*out|delete|remove|reset|purchase|checkout|approve)\b)/i;
const asset = /\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|mp3|mp4|mpeg|pdf|png|pptx?|svg|tar|tiff?|ttf|txt|wav|webm|webp|woff2?|xlsx?|xml|zip)$/i;
function normalizeUrl(value) { const u = new URL(value); u.hash = ''; if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error('Unsupported URL'); return u.href; }
function reason(value, label = '', extraForbidden = []) {
  let u; try { u = new URL(normalizeUrl(value)); } catch { return 'unsupported-url'; }
  if (unsafe.test(decodeURIComponent(u.pathname + u.search)) || unsafeLabel.test(label)) return 'state-changing-link';
  if (extraForbidden.some(x => x && label.toLowerCase().includes(x.toLowerCase()))) return 'forbidden-action';
  if (asset.test(u.pathname)) return 'asset-or-download';
  return null;
}
function isLogin(page) { return /\/(?:login|log-in|signin|sign-in|sign_in|logon|authenticate)(?:\.[a-z0-9]+)?\/?$/i.test(new URL(page.url).pathname) || /ログイン|サインイン|\blog[ -]?in\b|\bsign[ -]?in\b/i.test(page.title) || (page.password && page.user && !page.authenticatedIndicator); }
function outcome({ pages, authenticationBlocked, errors, remaining, limit }) {
  if (!pages) return 'failed';
  if (authenticationBlocked || errors || remaining || limit) return 'partial';
  return 'completed';
}
module.exports = { normalizeUrl, reason, isLogin, outcome };
