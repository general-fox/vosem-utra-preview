// FlashCall.ru incoming verification. Only the server can approve a phone number.
// Device hints affect presentation only. A narrow desktop window must never trigger a dialler.
export function isPhoneDevice(nav = globalThis.navigator) {
  const ua=nav?.userAgent || '';
  if (/iPad|Tablet|Silk|PlayBook/i.test(ua) || /Macintosh/i.test(ua) && nav?.maxTouchPoints>1) return false;
  return /iPhone|iPod|Windows Phone/i.test(ua) || /Android/i.test(ua) && /Mobile/i.test(ua) || nav?.userAgentData?.mobile===true;
}
export function phoneErrorMessage(data) {
  const message=data.Message || 'Не удалось подтвердить телефон. Попробуйте ещё раз.';
  const seconds=Math.ceil(Number(data.retryAfter)||0);
  if(data.Code==='phone_budget_exhausted' || seconds<=0) return message;
  return message + (seconds<60 ? ` Повторите через ${seconds} с.` : ` Повторите через ${Math.ceil(seconds/60)} мин.`);
}
export class PhoneVerification {
  constructor({ document, request, onChange = () => {}, guestPresentation = false, preview = false, mobilePhone = isPhoneDevice(document.defaultView?.navigator), autoDial = true, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
    this.doc=document; this.request=request; this.onChange=onChange; this.guestPresentation=guestPresentation; this.now=now; this.clearTimer=clearTimer;
    this.preview=preview; this.mobilePhone=mobilePhone; this.autoDial=autoDial && !preview; this.dialled=new Set();
    this.challenge=null; this.number=''; this.required=false; this.test=false; this.busy=false; this.generation=0;
    this.panel=document.getElementById('phone-verification'); this.status=document.getElementById('phone-status');
    this.panel.dataset.phoneDevice=mobilePhone ? 'phone' : 'other';
    this.resend=document.getElementById('phone-resend'); this.error=document.getElementById('phone-error');
    this.timer=setTimer(()=>{this.renderTime(); if(this.challenge?.state==='waiting' && this.doc.visibilityState!=='hidden' && !this.busy && this.pollAt<=this.now()) void this.poll();},1000);
  }
  configure(required,test) {
    this.required=required; this.test=test;
    this.doc.getElementById('phone-consent-row').hidden=!required;
    this.doc.getElementById('phone-consent').required=required;
    const note=this.doc.getElementById('phone-test-note'); if(note) note.hidden=!test || this.guestPresentation;
    if(!required) this.reset();
  }
  reset() { this.generation++; this.challenge=null; this.payload=null; this.number=''; this.panel.hidden=true; this.error.hidden=true; }
  invalidate() { this.generation++; if(this.challenge) {this.challenge.verified=false;this.challenge.state='expired';this.renderTime();} }
  showError(message) { this.error.textContent=message; this.error.hidden=false; }
  accept(data,number) {
    if(!data || !/^[a-f0-9]{32}$/.test(data.challengeId || '') || data.method!=='incoming' || !Number.isFinite(data.expiresIn) || data.expiresIn<0 || data.expiresIn>60 || !Number.isFinite(data.retryAfter)
      || !['waiting','verified','expired','failed','unknown','consumed'].includes(data.state)) throw Error('Некорректный ответ проверки телефона.');
    if(!this.preview && data.state==='waiting' && data.expiresIn>0 && !/^\+7\d{10}$/.test(data.phoneToCall || '')) throw Error('Не удалось получить проверочный номер.');
    const same=this.challenge?.id===data.challengeId;
    const expires=this.now()+data.expiresIn*1000;
    this.challenge={id:data.challengeId,method:'incoming',state:data.state,expires:same ? Math.min(this.challenge.expires,expires) : expires,
      resendAt:this.now()+data.retryAfter*1000,verified:data.verified===true,proofExpires:this.now()+(Number(data.proofExpiresIn)||0)*1000,statusIssue:Boolean(data.connectionMessage)};
    this.number=number; this.panel.hidden=false;
    const link=this.doc.getElementById('phone-call-link');
    const displayedNumber=this.doc.getElementById('phone-call-number');
    if(!this.preview && /^\+7\d{10}$/.test(data.phoneToCall || '')) {
      const formatted=data.phoneToCall.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/,'$1 ($2) $3-$4-$5');
      if(this.mobilePhone) link.href=`tel:${data.phoneToCall}`; else link.removeAttribute('href');
      link.textContent='Позвонить: '+formatted; displayedNumber.textContent=formatted;
    } else {link.removeAttribute('href');link.textContent='';displayedNumber.textContent='';}
    this.status.textContent=data.verified ? 'Номер подтверждён. Завершаем…'
      : data.state==='waiting' ? this.preview ? 'Это демонстрация — звонить не нужно.'
        : `Позвоните с ${data.phoneMask || 'номера из анкеты'} на номер:`
      : data.state==='expired' ? 'Время истекло. Попробуйте ещё раз.'
      : data.connectionMessage || 'Не удалось завершить проверку. Повторите запрос после окончания таймера.';
    this.doc.getElementById('phone-call-help').textContent=this.preview ? 'Настоящий звонок можно проверить на test888.ru.' : this.mobilePhone
      ? 'Выберите нужную SIM и вернитесь сюда после звонка.'
      : 'Подтверждение появится автоматически.';
    this.error.hidden=true; this.renderTime(); this.onChange();
  }
  renderTime() {
    const c=this.challenge; if(!c) return;
    if(c.verified && c.proofExpires<=this.now()) {c.verified=false;c.state='expired';this.status.textContent='Подтверждение истекло. Начните новую проверку.';this.onChange();}
    const remaining=Math.max(0,Math.ceil((c.expires-this.now())/1000));
    const retry=Math.max(0,Math.ceil((c.resendAt-this.now())/1000));
    const waiting=c.state==='waiting';
    this.doc.getElementById('phone-incoming-panel').hidden=!waiting;
    this.doc.getElementById('phone-call-link').hidden=!waiting || !remaining || !this.mobilePhone || this.preview;
    this.doc.getElementById('phone-call-number').hidden=!waiting || !remaining || this.mobilePhone || this.preview;
    this.doc.getElementById('phone-preview-confirm').hidden=!this.preview || !waiting || !remaining;
    this.doc.getElementById('phone-call-help').hidden=!waiting || !remaining;
    this.doc.getElementById('phone-poll').disabled=this.busy || !waiting;
    this.doc.getElementById('phone-poll').hidden=!waiting || !c.statusIssue;
    this.resend.hidden=waiting || c.verified;
    this.resend.disabled=this.busy || retry>0;
    this.resend.textContent=retry ? `Новая проверка через ${retry} с` : 'Начать новую проверку';
    this.doc.getElementById('phone-code-time').textContent=c.verified || this.preview ? ''
      : waiting ? remaining ? `На звонок осталось ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}` : 'Уточняем результат звонка…' : '';
  }
  async send(payload,resend=false) {
    if(this.busy) return false;
    const generation=this.generation; this.number=payload.Phone; this.busy=true; this.renderTime();
    try {
      const data=await this.request({...payload,Action:resend ? 'phone-resend' : 'phone-start'});
      if(generation!==this.generation) return false;
      this.payload=payload; this.accept(data.phoneVerification,payload.Phone); this.pollAt=this.now()+2000;
      // Only a user-requested start/resend may open the phone app, once per challenge.
      // Polling, returning to the tab, or reopening the same live challenge must not do it again.
      const c=this.challenge;
      if(this.mobilePhone && this.autoDial && c.state==='waiting' && c.expires>this.now() && this.doc.visibilityState!=='hidden' && !this.dialled.has(c.id)) {
        this.dialled.add(c.id);
        try { this.doc.getElementById('phone-call-link').click(); } catch { /* The visible link remains available if the browser blocks launching. */ }
      }
      return false;
    } catch(error) {
      if(generation===this.generation) {if(this.challenge && error.retryAfter)this.challenge.resendAt=this.now()+error.retryAfter*1000;this.showError(error.message);}
      throw error;
    } finally {this.busy=false;this.renderTime();}
  }
  async confirm(payload) {
    if(!this.required) return true;
    if(!this.challenge || this.number!==payload.Phone) return this.send(payload);
    this.renderTime();
    if(this.challenge.verified) return true;
    await this.poll(payload);
    return this.challenge?.verified===true;
  }
  async poll(payload=this.payload) {
    if(this.busy || !payload || this.number!==payload.Phone || this.challenge?.state!=='waiting') return;
    const generation=this.generation; this.busy=true; this.renderTime();
    try {
      const data=await this.request({...payload,Action:'phone-status',ChallengeId:this.challenge.id});
      if(generation===this.generation) this.accept(data.phoneVerification,payload.Phone);
    } catch(error) {
      if(generation===this.generation) {
        this.showError(error.message);
        if(this.challenge) this.challenge.statusIssue=true;
        // A final poll must happen at/after the deadline; a network failure cannot loop forever.
        if(this.challenge && this.challenge.expires<=this.now()) this.challenge.state='failed';
      }
    } finally {this.pollAt=this.now()+2000;this.busy=false;this.renderTime();}
  }
  dispose() {this.clearTimer(this.timer);this.reset();}
}
