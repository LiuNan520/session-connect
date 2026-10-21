import { useRef, useState, type FocusEvent, type Ref } from 'react';
import { countChars } from '#shared';
import { inputValue, singleLine } from '../logic/text';
import { DEFAULT_ICON } from '../store';

const FALLBACK = `/icons/${DEFAULT_ICON}`;

/** 图标图片：找不到或加载失败时显示 Claude Code 图标（只回退一次，避免循环）。 */
export function IconImg({ src, className, alt = '' }: { src: string; className?: string; alt?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const shown = failedSrc === src ? FALLBACK : src;
  return (
    <img
      className={className}
      src={shown}
      alt={alt}
      draggable={false}
      onError={() => { if (shown !== FALLBACK) setFailedSrc(src); }}
    />
  );
}

interface TextFieldProps {
  value: string;
  max: number;
  onChange(value: string): void;
  onFocus?(event: FocusEvent<HTMLInputElement>): void;
  onBlur?(event: FocusEvent<HTMLInputElement>): void;
  onEscape?(): void;
  inputRef?: Ref<HTMLInputElement>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}

/**
 * 单行输入框：按"字"限制长度（到上限输不进去，粘贴超长截断），粘贴的换行变成空格；
 * 输入法组字期间不截断；回车等于"点别处"。
 */
export function TextField(props: TextFieldProps) {
  const { value, max, onChange } = props;
  const composing = useRef(false);
  const accept = (raw: string) => {
    const line = singleLine(raw);
    if (countChars(line) > max && countChars(value) >= max) return; // 已到上限：输不进去
    onChange(inputValue(line, max));
  };
  return (
    <input
      ref={props.inputRef}
      type="text"
      className={props.className}
      value={value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      aria-label={props.ariaLabel}
      spellCheck={false}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={e => { composing.current = false; onChange(inputValue(e.currentTarget.value, max)); }}
      onChange={e => { if (composing.current) onChange(singleLine(e.target.value)); else accept(e.target.value); }}
      onPaste={e => {
        const text = e.clipboardData.getData('text');
        if (/[\r\n\u2028\u2029]/.test(text)) {
          e.preventDefault();
          if (!document.execCommand('insertText', false, singleLine(text))) {
            const el = e.currentTarget;
            const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? value.length;
            onChange(inputValue(value.slice(0, start) + singleLine(text) + value.slice(end), max));
          }
        }
      }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || composing.current) return;
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape' && props.onEscape) { e.preventDefault(); e.stopPropagation(); props.onEscape(); }
      }}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
    />
  );
}
