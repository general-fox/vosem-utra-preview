// A text field keeps the numeric keyboard available on Android and iOS.
const DATE_ERROR = 'Введите дату рождения в формате ДД.ММ.ГГГГ.';

export function formatBirthDate(value) {
  const text = String(value ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const separated = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text);
  if (separated) return `${separated[1].padStart(2, '0')}.${separated[2].padStart(2, '0')}.${separated[3]}`;
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('.');
}

export function parseBirthDate(value, today = new Date()) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value ?? ''));
  if (!match) return { value: null, error: DATE_ERROR };
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  if (year < 1900) return { value: null, error: 'Укажите год рождения не раньше 1900.' };
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return { value: null, error: 'Такой даты нет. Проверьте день, месяц и год.' };
  }
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  const limit = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (result > limit) return { value: null, error: 'Дата рождения не может быть в будущем.' };
  return { value: result, error: '' };
}

function caretAfterDigits(text, count) {
  if (count <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) if (/\d/.test(text[i]) && ++seen === count) return i + 1;
  return text.length;
}

export function attachBirthDateInput(input, { today = () => new Date() } = {}) {
  function validate() {
    const result = parseBirthDate(input.value, today());
    input.setCustomValidity(input.value ? result.error : '');
    return Boolean(result.value);
  }
  function format() {
    const raw = input.value, caret = input.selectionStart ?? raw.length;
    const before = raw.slice(0, caret).replace(/\D/g, '').length;
    const completePaste = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-]\d{4})$/.test(raw.trim());
    input.value = formatBirthDate(raw);
    // Normal typing retains the cursor; pasted dates with reordered fields end at the year.
    const position = completePaste && input.value !== raw ? input.value.length : caretAfterDigits(input.value, before);
    input.setSelectionRange(position, position);
    validate();
  }
  input.addEventListener('input', format);
  input.addEventListener('blur', format);
  input.addEventListener('change', format);
  input.addEventListener('beforeinput', event => {
    if (!event.cancelable || !['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)) return;
    const start = input.selectionStart, end = input.selectionEnd;
    if (start === null || start !== end) return;
    const positions = [...input.value].map((char, index) => /\d/.test(char) ? index : -1).filter(index => index >= 0);
    const index = event.inputType === 'deleteContentBackward'
      ? positions.filter(position => position < start).pop()
      : positions.find(position => position >= start);
    event.preventDefault();
    if (index === undefined) return;
    const digits = positions.map(position => input.value[position]);
    const digitIndex = positions.indexOf(index);
    digits.splice(digitIndex, 1);
    input.value = formatBirthDate(digits.join(''));
    const position = caretAfterDigits(input.value, digitIndex);
    input.setSelectionRange(position, position);
    validate();
  });
  // Restore/autofill may supply the native ISO format before the module starts.
  if (input.value) format();
  return { validate, value: () => parseBirthDate(input.value, today()).value };
}
