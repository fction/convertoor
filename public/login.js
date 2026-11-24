const form = document.querySelector('form');
const message = document.querySelector('#message');
const endpoint = '/api/gateway?view=';
fetch(endpoint + 'session', {cache:'no-store'}).then(r => { if (r.ok) location.replace('/studio'); }).catch(() => {});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = 'Проверяем данные…';
  try {
    const r = await fetch(endpoint + 'login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(Object.fromEntries(new FormData(form)))});
    if (!r.ok) throw new Error((await r.json()).error || 'Не удалось войти. Попробуйте ещё раз.');
    form.reset();
    location.replace('/studio');
  } catch (error) { message.textContent = error.message === 'Failed to fetch' ? 'Нет связи с сервером.' : error.message; button.disabled = false; }
});
