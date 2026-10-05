// The browser only holds an opaque challenge ID; expected codes stay on the server.
export class PhoneVerification {
  constructor({ document, request, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
    this.doc = document; this.request = request; this.now = now; this.clearTimer = clearTimer;
    this.challenge = null; this.number = ''; this.required = false; this.test = false; this.busy = false;
    this.panel = document.getElementById('phone-verification');
    this.code = document.getElementById('phone-code');
    this.status = document.getElementById('phone-status');
    this.resend = document.getElementById('phone-resend');
    this.error = document.getElementById('phone-error');
    this.code.addEventListener('input', () => { this.code.value = this.code.value.replace(/\D/g,'').slice(0,4); this.error.hidden = true; });
    this.timer = setTimer(() => this.renderTime(), 1000);
  }
  configure(required, test) {
    this.required = required; this.test = test;
    this.doc.getElementById('phone-consent-row').hidden = !required;
    this.doc.getElementById('phone-consent').required = required;
    this.doc.getElementById('phone-test-note').hidden = !test;
    this.doc.getElementById('phone-check-panel').hidden = !test;
    if (!required) this.reset();
  }
  reset() { this.challenge = null; this.number = ''; this.code.value = ''; this.panel.hidden = true; this.error.hidden = true; }
  invalidate() { if (this.challenge) { this.challenge.verified = false; this.challenge.expires = 0; this.code.value = ''; this.renderTime(); } }
  showError(message) { this.error.textContent = message; this.error.hidden = false; }
  accept(data, number) {
    if (!data || typeof data.challengeId !== 'string' || !/^[a-f0-9]{32}$/.test(data.challengeId) || !Number.isFinite(data.expiresIn) || !Number.isFinite(data.retryAfter)) throw Error('phone_response');
    this.number = number;
    this.challenge = { id:data.challengeId, expires:this.now()+data.expiresIn*1000, resendAt:this.now()+data.retryAfter*1000, verified:data.verified===true };
    this.panel.hidden = false;
    this.doc.getElementById('phone-target').textContent = data.phoneMask || 'указанный номер';
    this.status.textContent = data.pending
      ? (this.test && typeof data.connectionMessage === 'string' && data.connectionMessage ? data.connectionMessage+' ' : '')+'Начало звонка не подтверждено. Если звонок всё же поступит, введите код.'
      : 'uCaller принял запрос. Ожидайте звонок и введите последние четыре цифры звонящего номера. Отвечать на звонок не нужно.';
    this.error.hidden = true; this.renderTime();
    if (!this.challenge.verified) this.code.focus();
  }
  renderTime() {
    if (!this.challenge) return;
    const seconds = Math.max(0,Math.ceil((this.challenge.resendAt-this.now())/1000));
    this.resend.disabled = this.busy || seconds > 0;
    this.resend.textContent = seconds ? `Повторить звонок через ${seconds} с` : 'Позвонить ещё раз';
    const remaining = Math.max(0,Math.ceil((this.challenge.expires-this.now())/1000));
    this.doc.getElementById('phone-code-time').textContent = this.challenge.verified ? 'Номер подтверждён.' : remaining ? `Код действует ещё ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}.` : 'Срок действия кода истёк. Запросите новый звонок.';
  }
  async send(payload, resend = false) {
    this.busy = true; this.renderTime();
    try {
      const data = await this.request({ ...payload, Action:resend ? 'phone-resend' : 'phone-start' });
      this.code.value = ''; this.accept(data.phoneVerification, payload.Phone);
      return false;
    } catch (error) {
      if (this.challenge && error.retryAfter) this.challenge.resendAt = this.now()+error.retryAfter*1000;
      this.showError(error.message); throw error;
    } finally { this.busy = false; this.renderTime(); }
  }
  async confirm(payload) {
    if (!this.required) return true;
    if (!this.challenge || this.number !== payload.Phone) return this.send(payload);
    if (this.challenge.expires <= this.now()) { this.showError('Срок действия кода истёк. Нажмите «Позвонить ещё раз».'); return false; }
    if (this.challenge.verified) return true;
    if (!/^\d{4}$/.test(this.code.value)) { this.showError('Введите четыре цифры из номера входящего звонка.'); this.code.focus(); return false; }
    this.busy = true; this.renderTime();
    try {
      const data = await this.request({ ...payload, Action:'phone-verify', ChallengeId:this.challenge.id, Code:this.code.value });
      this.accept(data.phoneVerification,payload.Phone);
      return this.challenge.verified;
    } catch (error) { this.showError(error.message); return false; }
    finally { this.busy = false; this.renderTime(); }
  }
  dispose() { this.clearTimer(this.timer); this.reset(); }
}
