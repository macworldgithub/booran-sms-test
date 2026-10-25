const form = document.getElementById('verify-form');
const result = document.getElementById('verify-result');
form.onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; result.textContent = '';
  try {
    const token = location.pathname.split('/')[2];
    const response = await fetch(`/api/verify/${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('code').value }), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Verification could not be completed.');
    form.hidden = true; result.className = 'success'; result.textContent = '✓ Phone verified. Your Booran test conversation has been updated. You can close this page.';
  } catch (error) { result.className = 'error'; result.textContent = error.message; }
  finally { button.disabled = false; }
};
