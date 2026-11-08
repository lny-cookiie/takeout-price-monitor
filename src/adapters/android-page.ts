import type { UiNode } from '@midscene/core';
import { digest, redactSensitive } from '../domain/competition.js';

export type PageState = 'HOME'|'SEARCH'|'RESULTS'|'STORE'|'MENU'|'ITEM'|'CART'|'CHECKOUT'|'RESTORE'|'FOREIGN'|'LOCKED'|'TRANSITION';

export interface Foreground { package: string | null; activity: string | null }
export type ForegroundKind = 'target'|'system'|'foreign'|'unknown';
export interface ImageSize { width: number; height: number }
export interface PageSnapshot {
  nodes: UiNode[];
  all: UiNode[];
  viewport: ImageSize;
  foreground: Foreground;
  at: string;
  structureKey: string;
  contentKey: string;
}
export interface PageExpectation {
  state: PageState;
  matches: (snapshot: PageSnapshot) => boolean;
  timeoutMs?: number;
  stableReads?: number;
}

export const textOf = (n: UiNode) => (n.attrs.text || n.attrs["content-desc"] || "").replace(/[\u200b-\u200f\u2060\ufeff]/g,"").trim();
export const resourceOf = (n: UiNode) => n.attrs['resource-id'] ?? '';
export const flatten = (node: UiNode): UiNode[] => [node,...node.children.flatMap(flatten)];

const shapeOf = (n: UiNode) => [resourceOf(n), n.attrs.class ?? '', n.bounds.left, n.bounds.top, n.bounds.width, n.bounds.height].join('|');
export function structureKey(nodes: UiNode[], foreground: Foreground): string {
  return digest([foreground.package ?? '', foreground.activity ?? '', ...nodes.map(shapeOf).sort()]);
}
export function contentKey(nodes: UiNode[], foreground: Foreground): string {
  return digest([foreground.package ?? '', foreground.activity ?? '', ...nodes.map(n=>shapeOf(n)+'|'+textOf(n)).sort()]);
}

const systemPackage = /^(com\.android\.systemui|com\.android\.permissioncontroller|com\.android\.inputmethod|com\.google\.android\.inputmethod)/i;
const launcherPackage = /launcher|systemui|permissioncontroller|inputmethod/i;
export function classifyForeground(packageName: string | null, target: string): ForegroundKind {
  if (!packageName) return 'unknown';
  if (packageName === target) return 'target';
  if (systemPackage.test(packageName) || launcherPackage.test(packageName)) return 'system';
  return 'foreign';
}

export interface CropPolicy {
  maxHeightRatio?: number;
  tolerancePx?: number;
  minPx?: number;
}
export interface CropBox { left: number; top: number; width: number; height: number }
export interface CropResult {
  boxes: CropBox[];
  location: CropBox | null;
  text: string;
  skipped: 'out_of_bounds'|'too_small'|'invalid'|null;
  redactions: CropBox[];
}

/**
 * Convert logical node bounds to screenshot pixels, clamp to the frame, and
 * split tall nodes into bands. Phone numbers are redacted in the returned text.
 * Returns a skipped reason instead of throwing so one bad node cannot fail a
 * whole evidence frame.
 */
export function cropBoxes(node: UiNode, viewport: ImageSize, image: ImageSize, policy: CropPolicy = {}): CropResult {
  const text = redactSensitive(textOf(node));
  const maxHeightRatio = policy.maxHeightRatio ?? .22;
  const tolerance = policy.tolerancePx ?? 2;
  const minPx = policy.minPx ?? 2;
  if (!(viewport.width>0 && viewport.height>0 && image.width>0 && image.height>0)) return {boxes:[],location:null,text,skipped:'invalid',redactions:[]};
  const sx = image.width/viewport.width, sy = image.height/viewport.height;
  const rawLeft = node.bounds.left*sx, rawTop = node.bounds.top*sy;
  const rawRight = (node.bounds.left+node.bounds.width)*sx, rawBottom = (node.bounds.top+node.bounds.height)*sy;
  if (![rawLeft,rawTop,rawRight,rawBottom].every(Number.isFinite)) return {boxes:[],location:null,text,skipped:'invalid',redactions:[]};
  if (rawRight < -tolerance || rawBottom < -tolerance || rawLeft > image.width+tolerance || rawTop > image.height+tolerance)
    return {boxes:[],location:null,text,skipped:'out_of_bounds',redactions:[]};
  const left = Math.max(0,Math.round(rawLeft)), top = Math.max(0,Math.round(rawTop));
  const right = Math.min(image.width,Math.round(rawRight)), bottom = Math.min(image.height,Math.round(rawBottom));
  const width = right-left, height = bottom-top;
  if (width<minPx || height<minPx) return {boxes:[],location:null,text,skipped:'too_small',redactions:[]};
  const location = {left,top,width,height};
  // Mask phone-number pixels, not just the JSON text. Evidence screenshots may be sent to the model.
  const redactions: CropBox[] = [];
  for (const child of flatten(node)) {
    if (!phonePattern.test(textOf(child))) continue;
    const l=Math.max(0,Math.round(child.bounds.left*sx)), t=Math.max(0,Math.round(child.bounds.top*sy));
    const r=Math.min(image.width,Math.round((child.bounds.left+child.bounds.width)*sx));
    const b=Math.min(image.height,Math.round((child.bounds.top+child.bounds.height)*sy));
    if (r-l>=minPx && b-t>=minPx) redactions.push({left:l,top:t,width:r-l,height:b-t});
  }
  if (height<=Math.floor(image.height*maxHeightRatio)) return {boxes:[location],location,text,skipped:null,redactions};
  const band = Math.max(minPx,Math.floor(image.height*maxHeightRatio));
  const boxes: CropBox[] = [];
  for (let y=top; y<bottom;) {
    const h = Math.min(band,bottom-y);
    if (h<minPx) {
      const last = boxes[boxes.length-1];
      if (last) last.height = bottom-last.top;
      break;
    }
    boxes.push({left,top:y,width,height:h});
    y += h;
  }
  return {boxes,location,text,skipped:boxes.length ? null : 'too_small',redactions};
}

const phonePattern = /1[3-9]\d{9}/;
