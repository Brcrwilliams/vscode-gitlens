/*global document*/
import type { Config } from '../../../config';
import {
	DidChangeConfigurationNotificationType,
	DidGenerateConfigurationPreviewNotificationType,
	DidOpenAnchorNotificationType,
	GenerateConfigurationPreviewCommandType,
	IpcMessage,
	onIpc,
	UpdateConfigurationCommandType,
} from '../../protocol';
import { formatDate, setDefaultDateLocales } from '../shared/date';
import { App } from './appBase';
import { DOM } from './dom';

const offset = (new Date().getTimezoneOffset() / 60) * 100;
const date = new Date(
	`Wed Jul 25 2018 19:18:00 GMT${offset >= 0 ? '-' : '+'}${String(Math.abs(offset)).padStart(4, '0')}`,
);

interface AppStateWithConfig {
	config: Config;
	customSettings?: Record<string, boolean>;
}

export abstract class AppWithConfig<State extends AppStateWithConfig> extends App<State> {
	private _changes = Object.create(null) as Record<string, any>;
	private _updating: boolean = false;

	constructor(appName: string) {
		super(appName);
	}

	protected override onInitialized() {
		this.updateState();
	}

	protected override onBind() {
		const disposables = super.onBind?.() ?? [];

		disposables.push(
			DOM.on('input[type=checkbox][data-setting]', 'change', (e, target: HTMLInputElement) =>
				this.onInputChecked(target),
			),
			DOM.on(
				'input[type=text][data-setting], input[type=number][data-setting], input:not([type])[data-setting]',
				'blur',
				(e, target: HTMLInputElement) => this.onInputBlurred(target),
			),
			DOM.on(
				'input[type=text][data-setting], input[type=number][data-setting], input:not([type])[data-setting]',
				'focus',
				(e, target: HTMLInputElement) => this.onInputFocused(target),
			),
			DOM.on(
				'input[type=text][data-setting][data-setting-preview], input[type=number][data-setting][data-setting-preview]',
				'input',
				(e, target: HTMLInputElement) => this.onInputChanged(target),
			),
			DOM.on('select[data-setting]', 'change', (e, target: HTMLSelectElement) => this.onInputSelected(target)),
			DOM.on('.token[data-token]', 'mousedown', (e, target: HTMLElement) => this.onTokenMouseDown(target, e)),
		);

		return disposables;
	}

	protected override onMessageReceived(e: MessageEvent) {
		const msg = e.data as IpcMessage;

		this.log(`${this.appName}.onMessageReceived(${msg.id}): name=${msg.method}`);

		switch (msg.method) {
			case DidOpenAnchorNotificationType.method: {
				onIpc(DidOpenAnchorNotificationType, msg, params => {
					this.scrollToAnchor(params.anchor, params.scrollBehavior);
				});
				break;
			}
			case DidChangeConfigurationNotificationType.method:
				onIpc(DidChangeConfigurationNotificationType, msg, params => {
					this.state.config = params.config;
					this.state.customSettings = params.customSettings;

					this.updateState();
				});
				break;

			default:
				super.onMessageReceived?.(e);
		}
	}

	protected applyChanges() {
		this.sendCommand(UpdateConfigurationCommandType, {
			changes: { ...this._changes },
			removes: Object.keys(this._changes).filter(k => this._changes[k] === undefined),
			scope: this.getSettingsScope(),
		});

		this._changes = Object.create(null) as Record<string, any>;
	}

	protected getSettingsScope(): 'user' | 'workspace' {
		return 'user';
	}

	protected onInputBlurred(element: HTMLInputElement) {
		this.log(`${this.appName}.onInputBlurred: name=${element.name}, value=${element.value}`);

		const $popup = document.getElementById(`${element.name}.popup`);
		if ($popup != null) {
			$popup.classList.add('hidden');
		}

		let value: string | null | undefined = element.value;
		if (value == null || value.length === 0) {
			value = element.dataset.defaultValue;
			if (value === undefined) {
				value = null;
			}
		}

		this._changes[element.name] = element.type === 'number' && value != null ? Number(value) : value;

		// this.setAdditionalSettings(element.checked ? element.dataset.addSettingsOn : element.dataset.addSettingsOff);
		this.applyChanges();
	}

	protected onInputChanged(element: HTMLInputElement) {
		if (this._updating) return;

		for (const el of document.querySelectorAll<HTMLSpanElement>(`span[data-setting-preview="${element.name}"]`)) {
			this.updatePreview(el, element.value);
		}
	}

	protected onInputChecked(element: HTMLInputElement) {
		if (this._updating) return;

		this.log(
			`${this.appName}.onInputChecked: name=${element.name}, checked=${element.checked}, value=${element.value}`,
		);

		switch (element.dataset.settingType) {
			case 'object': {
				const props = element.name.split('.');
				const settingName = props.splice(0, 1)[0];
				const setting = this.getSettingValue(settingName) ?? Object.create(null);

				if (element.checked) {
					set(setting, props.join('.'), fromCheckboxValue(element.value));
				} else {
					set(setting, props.join('.'), false);
				}

				this._changes[settingName] = setting;

				break;
			}
			case 'array': {
				const setting = this.getSettingValue(element.name) ?? [];
				if (Array.isArray(setting)) {
					if (element.checked) {
						if (!setting.includes(element.value)) {
							setting.push(element.value);
						}
					} else {
						const i = setting.indexOf(element.value);
						if (i !== -1) {
							setting.splice(i, 1);
						}
					}
					this._changes[element.name] = setting;
				}

				break;
			}
			case 'custom': {
				this._changes[element.name] = element.checked;

				break;
			}
			default: {
				if (element.checked) {
					this._changes[element.name] = fromCheckboxValue(element.value);
				} else {
					this._changes[element.name] = element.dataset.valueOff == null ? false : element.dataset.valueOff;
				}

				break;
			}
		}

		this.setAdditionalSettings(element.checked ? element.dataset.addSettingsOn : element.dataset.addSettingsOff);
		this.applyChanges();
	}

	protected onInputFocused(element: HTMLInputElement) {
		this.log(`${this.appName}.onInputFocused: name=${element.name}, value=${element.value}`);

		const $popup = document.getElementById(`${element.name}.popup`);
		if ($popup != null) {
			if ($popup.childElementCount === 0) {
				const $template = (document.querySelector('#token-popup') as HTMLTemplateElement)?.content.cloneNode(
					true,
				);
				$popup.appendChild($template);
			}
			$popup.classList.remove('hidden');
		}
	}

	protected onInputSelected(element: HTMLSelectElement) {
		if (this._updating) return;

		const value = element.options[element.selectedIndex].value;

		this.log(`${this.appName}.onInputSelected: name=${element.name}, value=${value}`);

		this._changes[element.name] = ensureIfBooleanOrNull(value);

		this.applyChanges();
	}

	protected onTokenMouseDown(element: HTMLElement, e: MouseEvent) {
		if (this._updating) return;

		this.log(`${this.appName}.onTokenClicked: id=${element.id}`);

		const setting = element.closest('.setting');
		if (setting == null) return;

		const input = setting.querySelector<HTMLInputElement>('input[type=text], input:not([type])');
		if (input == null) return;

		const token = `\${${element.dataset.token}}`;
		let selectionStart = input.selectionStart;
		if (selectionStart != null) {
			input.value = `${input.value.substring(0, selectionStart)}${token}${input.value.substr(
				input.selectionEnd ?? selectionStart,
			)}`;

			selectionStart += token.length;
		} else {
			selectionStart = input.value.length;
		}

		input.focus();
		input.setSelectionRange(selectionStart, selectionStart);
		if (selectionStart === input.value.length) {
			input.scrollLeft = input.scrollWidth;
		}

		setTimeout(() => this.onInputChanged(input), 0);
		setTimeout(() => input.focus(), 250);

		e.stopPropagation();
		e.stopImmediatePropagation();
		e.preventDefault();
	}

	protected scrollToAnchor(anchor: string, behavior: ScrollBehavior, offset?: number) {
		const el = document.getElementById(anchor);
		if (el == null) return;

		this.scrollTo(el, behavior, offset);
	}

	private _scrollTimer: ReturnType<typeof setTimeout> | undefined;
	private scrollTo(el: HTMLElement, behavior: ScrollBehavior, offset?: number) {
		const top = el.getBoundingClientRect().top - document.body.getBoundingClientRect().top - (offset ?? 0);

		window.scrollTo({
			top: top,
			behavior: behavior ?? 'smooth',
		});

		const fn = () => {
			if (this._scrollTimer != null) {
				clearTimeout(this._scrollTimer);
			}

			this._scrollTimer = setTimeout(() => {
				window.removeEventListener('scroll', fn);

				const newTop =
					el.getBoundingClientRect().top - document.body.getBoundingClientRect().top - (offset ?? 0);
				if (top === newTop) return;

				this.scrollTo(el, behavior, offset);
			}, 50);
		};

		window.addEventListener('scroll', fn, false);
	}

	private evaluateStateExpression(expression: string, changes: Record<string, string | boolean>): boolean {
		let state = false;
		for (const expr of expression.trim().split('&')) {
			const [lhs, op, rhs] = parseStateExpression(expr);

			switch (op) {
				case '=': {
					// Equals
					let value = changes[lhs];
					if (value === undefined) {
						value = this.getSettingValue<string | boolean>(lhs) ?? false;
					}
					state = rhs !== undefined ? rhs === String(value) : Boolean(value);
					break;
				}
				case '!': {
					// Not equals
					let value = changes[lhs];
					if (value === undefined) {
						value = this.getSettingValue<string | boolean>(lhs) ?? false;
					}
					// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
					state = rhs !== undefined ? rhs !== String(value) : !value;
					break;
				}
				case '+': {
					// Contains
					if (rhs !== undefined) {
						const setting = this.getSettingValue<string[]>(lhs);
						state = setting !== undefined ? setting.includes(rhs.toString()) : false;
					}
					break;
				}
			}

			if (!state) break;
		}
		return state;
	}

	private getCustomSettingValue(path: string): boolean | undefined {
		return this.state.customSettings?.[path];
	}

	private getSettingValue<T>(path: string): T | undefined {
		const customSetting = this.getCustomSettingValue(path);
		if (customSetting != null) return customSetting as any;

		return get<T>(this.state.config, path);
	}

	private updateState() {
		this._updating = true;

		setDefaultDateLocales(this.state.config.defaultDateLocale);

		try {
			for (const el of document.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-setting]')) {
				if (el.dataset.settingType === 'custom') {
					el.checked = this.getCustomSettingValue(el.name) ?? false;
				} else if (el.dataset.settingType === 'array') {
					el.checked = (this.getSettingValue<string[]>(el.name) ?? []).includes(el.value);
				} else if (el.dataset.valueOff != null) {
					const value = this.getSettingValue<string>(el.name);
					el.checked = el.dataset.valueOff !== value;
				} else {
					el.checked = this.getSettingValue<boolean>(el.name) ?? false;
				}
			}

			for (const el of document.querySelectorAll<HTMLInputElement>(
				'input[type=text][data-setting], input[type=number][data-setting], input:not([type])[data-setting]',
			)) {
				el.value = this.getSettingValue<string>(el.name) ?? '';
			}

			for (const el of document.querySelectorAll<HTMLSelectElement>('select[data-setting]')) {
				const value = this.getSettingValue<string>(el.name);
				const option = el.querySelector<HTMLOptionElement>(`option[value='${value}']`);
				if (option != null) {
					option.selected = true;
				}
			}

			for (const el of document.querySelectorAll<HTMLSpanElement>('span[data-setting-preview]')) {
				this.updatePreview(el);
			}
		} finally {
			this._updating = false;
		}

		const state = flatten(this.state.config);
		this.setVisibility(state);
		this.setEnablement(state);
	}

	private setAdditionalSettings(expression: string | undefined) {
		if (!expression) return;

		const addSettings = parseAdditionalSettingsExpression(expression);
		for (const [s, v] of addSettings) {
			this._changes[s] = v;
		}
	}

	private setEnablement(state: Record<string, string | boolean>) {
		for (const el of document.querySelectorAll<HTMLElement>('[data-enablement]')) {
			const disabled = !this.evaluateStateExpression(el.dataset.enablement!, state);
			if (disabled) {
				el.setAttribute('disabled', '');
			} else {
				el.removeAttribute('disabled');
			}

			if (el.matches('input,select')) {
				(el as HTMLInputElement | HTMLSelectElement).disabled = disabled;
			} else {
				const input = el.querySelector<HTMLInputElement | HTMLSelectElement>('input,select');
				if (input == null) continue;

				input.disabled = disabled;
			}
		}
	}

	private setVisibility(state: Record<string, string | boolean>) {
		for (const el of document.querySelectorAll<HTMLElement>('[data-visibility]')) {
			el.classList.toggle('hidden', !this.evaluateStateExpression(el.dataset.visibility!, state));
		}
	}

	private updatePreview(el: HTMLSpanElement, value?: string) {
		switch (el.dataset.settingPreviewType) {
			case 'date': {
				if (value === undefined) {
					value = this.getSettingValue<string>(el.dataset.settingPreview!);
				}

				if (!value) {
					value = el.dataset.settingPreviewDefault;
				}

				el.innerText = value == null ? '' : formatDate(date, value, undefined, false);
				break;
			}
			case 'date-locale': {
				if (value === undefined) {
					value = this.getSettingValue<string>(el.dataset.settingPreview!);
				}

				if (!value) {
					value = undefined;
				}

				const format = this.getSettingValue<string>(el.dataset.settingPreviewDefault!) ?? 'MMMM Do, YYYY h:mma';
				try {
					el.innerText = formatDate(date, format, value, false);
				} catch (ex) {
					el.innerText = ex.message;
				}
				break;
			}
			case 'commit': {
				if (value === undefined) {
					value = this.getSettingValue<string>(el.dataset.settingPreview!);
				}

				if (!value) {
					value = el.dataset.settingPreviewDefault;
				}

				if (value == null) {
					el.innerText = '';

					return;
				}

				this.sendCommandWithCompletion(
					GenerateConfigurationPreviewCommandType,
					{
						key: el.dataset.settingPreview!,
						type: 'commit',
						format: value,
					},
					DidGenerateConfigurationPreviewNotificationType,
					params => {
						el.innerText = params.preview ?? '';
					},
				);

				break;
			}
			default:
				break;
		}
	}
}

function ensureIfBooleanOrNull(value: string | boolean): string | boolean | null {
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null') return null;
	return value;
}

function get<T>(o: Record<string, any>, path: string): T | undefined {
	return path.split('.').reduce((o = {}, key) => (o == null ? undefined : o[key]), o) as T;
}

function set(o: Record<string, any>, path: string, value: any): Record<string, any> {
	const props = path.split('.');
	const length = props.length;
	const lastIndex = length - 1;

	let index = -1;
	let nested = o;

	while (nested != null && ++index < length) {
		const key = props[index];
		let newValue = value;

		if (index !== lastIndex) {
			const objValue = nested[key];
			newValue = typeof objValue === 'object' ? objValue : {};
		}

		nested[key] = newValue;
		nested = nested[key];
	}

	return o;
}

function parseAdditionalSettingsExpression(expression: string): [string, string | boolean | null][] {
	const settingsExpression = expression.trim().split(',');
	return settingsExpression.map<[string, string | boolean | null]>(s => {
		const [setting, value] = s.split('=');
		return [setting, ensureIfBooleanOrNull(value)];
	});
}

function parseStateExpression(expression: string): [string, string, string | boolean | undefined] {
	const [lhs, op, rhs] = expression.trim().split(/([=+!])/);
	return [lhs.trim(), op !== undefined ? op.trim() : '=', rhs !== undefined ? rhs.trim() : rhs];
}

function flatten(o: Record<string, any>, path?: string): Record<string, any> {
	const results: Record<string, any> = {};

	for (const key in o) {
		const value = o[key];
		if (Array.isArray(value)) continue;

		if (typeof value === 'object') {
			Object.assign(results, flatten(value, path === undefined ? key : `${path}.${key}`));
		} else {
			results[path === undefined ? key : `${path}.${key}`] = value;
		}
	}

	return results;
}

function fromCheckboxValue(elementValue: any) {
	switch (elementValue) {
		case 'on':
			return true;
		case 'null':
			return null;
		case 'undefined':
			return undefined;
		default:
			return elementValue;
	}
}
