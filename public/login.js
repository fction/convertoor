const form = document.querySelector('form');
const message = document.querySelector('#message');
const endpoint = '/api/gateway?view=';
fetch(endpoint + 'session', {cache:'no-store'}).then(r => { if (r.ok) location.replace('/studio'); }).catch(() => {});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = 'Signing in…';
  try {
    const r = await fetch(endpoint + 'login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if (r.status === 429) {
      const minutes = Math.ceil(Number(r.headers.get('Retry-After')) / 60);
      const wait = minutes > 0 && Number.isFinite(minutes) ? 'in ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.') : 'later.';
      throw new Error('Too many sign-in attempts. Try again ' + wait);
    }
    if (!r.ok) {
      const details = await r.json().catch(() => ({}));
      throw new Error(details.error || 'Could not sign in. Please try again.');
    }
    form.reset();
    location.replace('/studio');
  } catch (error) { message.textContent = error.message === 'Failed to fetch' ? 'Could not reach the server. Check your connection and try again.' : error.message; button.disabled = false; }
});
