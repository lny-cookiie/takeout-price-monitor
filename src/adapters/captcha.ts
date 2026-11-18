// 风控/验证码识别：只用来“识别并停止”，绝不自动点击验证码或尝试破解。
export const CAPTCHA_PATTERN = /拖动滑块|滑动验证|请完成验证|安全验证|人机验证|验证码|点击验证|按住滑块|拖动到|拼图验证|完成验证|请输入图片中的内容|图片中的内容|请输入验证|图形码|字符验证|点击图片中/;

/** 页面标签里出现验证码/滑块等风控字样时返回 true。 */
export function looksLikeCaptcha(labels: string[]): boolean {
  return labels.some((label) => CAPTCHA_PATTERN.test(label));
}

/** 统一的风控错误：调度器会暂停该平台，等待人工在手机上完成验证后再继续。 */
export class CaptchaEncountered extends Error {
  readonly code = 'captcha_required';
  constructor() { super('captcha_required'); }
}
