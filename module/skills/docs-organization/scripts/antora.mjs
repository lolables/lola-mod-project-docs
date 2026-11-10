// Antora component layout from antora.yml, read as data (site-yaml.mjs),
// and xref resolution against it. Per the Antora docs: antora.yml sits beside
// modules/; nav file paths are relative to antora.yml; the start page
// defaults to ROOT's index.adoc; files and directories whose name starts
// with `_` are not published, `.` ones not loaded; an xref path is relative
// to the target family's root (pages/ for a page) unless it starts with `./`
// (the current file's directory); `component::page.adoc` is the ROOT module.
//
// readAntora(descriptorPath, text, tracked) returns
//   {name, version, contentRoot, prefix, navFiles, pages, startPage}
//   prefix     contentRoot + '/', or '' when antora.yml is at the root
//   pages      tracked, published .adoc files under modules/*/pages/, sorted
//   startPage  the start page's repo path when tracked, else null
// resolveXref(target, fromPath, component, defaultFamily = 'page') returns
//   defaultFamily is the family a target without a $ coordinate names: page for an xref, image for an image macro
//   {path}           the repo path the xref names (the caller checks it exists)
//   {path, unpublished}  as {path}, but the page sits under a _ or . segment,
//                    so Antora does not publish it: the link is broken on the
//                    site whether or not the file exists; `unpublished` says why
//   {unresolvable}   why it points outside what this repo holds (another
//                    component or version, an xref inside a partial, a ./ path
//                    from another family): never reported as broken
//   {unresolvable, invalid: true}  as {unresolvable}, but the author wrote a
//                    reference no Antora site can resolve (a malformed ID or
//                    module name, an unknown family, a path that leaves its
//                    family directory): check-refs reports it as broken
//   null             not a resource reference: external URL, pure anchor, or
//                    an absolute image path (served from the UI bundle or site root)
// resolveLink(target, fromPath, component) maps a `link:` macro target in an
//   AsciiDoc page under modules/ to a repo file. Antora resolves the target
//   against the published page URL, not the .adoc source (ROOT pages publish
//   at the component root, module M's under M/), so only two shapes map to a
//   file; returns
//   {path}           `x.html` -> the page `x.adoc` the published URL names: the
//                    source page's published directory plus the target, mapped
//                    back to a module (a leading segment naming a module with
//                    pages, else ROOT); a `_attachments/` segment (or a leading
//                    `{attachmentsdir}/`) -> the same module's attachments/ file
//   {unresolvable}   any other relative target (other file type, leaving the
//                    component, a ROOT directory named like a module): never
//                    reported as broken
//   null             external URL or pure anchor
// loadComponent(root, tracked, descriptorPath, tolerate) reads the descriptor
//   under root and returns {component} or, when tolerated, {configError}
// readPlaybookUrl(path, text) returns site.url, or null.

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadSiteYaml, ConfigError } from './site-yaml.mjs';
import { isExternal, decodeTarget } from './link-targets.mjs';
import { formatFor } from './formats/index.mjs';

const FAMILY_DIRS = { page: 'pages', partial: 'partials', example: 'examples', attachment: 'attachments', image: 'images' };
const FAMILY_OF_DIR = Object.fromEntries(Object.entries(FAMILY_DIRS).map(([f, d]) => [d, f]));
const hidden = (segment) => segment.startsWith('_') || segment.startsWith('.');
// A page under a hidden segment is not published: a link to it is dead on the site.
const unpublished = (rel) => rel.split('/').some(hidden);

// Which resolver a reference in `path` (repo-relative) takes; check-refs and
// nav-graph both dispatch on this so they cannot drift. Returns
//   'resource'  an Antora resource ID (xref, image, `family$` include): resolveXref
//   'link'      a `link:` macro: resolveLink
//   'path'      a plain filesystem path
// Only AsciiDoc under `modulesPrefix` (the component's `modules/`) takes Antora
// rules; Antora never processes Markdown, so other formats keep path resolution.
export function antoraRefPolicy(path, ref, modulesPrefix) {
  if (formatFor(path)?.name !== 'asciidoc' || !path.startsWith(modulesPrefix)) return 'path';
  if (ref.kind === 'xref' || ref.kind === 'image' || (ref.kind === 'include' && ref.target.includes('$'))) return 'resource';
  return ref.kind === 'link' ? 'link' : 'path';
}

export function readAntora(descriptorPath, text, tracked) {
  const d = loadSiteYaml(descriptorPath, text);
  if (typeof d.name !== 'string' || d.name === '') throw new ConfigError(`${descriptorPath}: name must be a non-empty string`);
  const nav = d.nav ?? [];
  if (!Array.isArray(nav) || nav.some((n) => typeof n !== 'string')) {
    throw new ConfigError(`${descriptorPath}: nav must be a list of file paths`);
  }
  const contentRoot = posix.dirname(descriptorPath);
  const prefix = contentRoot === '.' ? '' : `${contentRoot}/`;
  // An unquoted numeric version (1.0) is read as the number 1, so a `1.0@`
  // xref is unresolvable: safe, never reported as broken.
  const version = typeof d.version === 'string' || typeof d.version === 'number' ? String(d.version) : null;
  const pages = [...tracked].filter((p) => {
    if (!p.startsWith(`${prefix}modules/`) || !p.endsWith('.adoc')) return false;
    const parts = p.slice(prefix.length).split('/');
    return parts.length >= 4 && parts[2] === 'pages' && !unpublished(parts.slice(3).join('/'));
  }).sort();
  const component = { name: d.name, version, contentRoot, prefix, navFiles: nav.map((n) => posix.normalize(prefix + n)), pages, startPage: null };
  const start = resolveXref(typeof d.start_page === 'string' ? d.start_page : 'ROOT:index.adoc', descriptorPath, component);
  component.startPage = start && start.path && !start.unpublished && tracked.has(start.path) ? start.path : null;
  return component;
}

// readAntora on the descriptor file under `root`. A malformed descriptor throws
// ConfigError, or with `tolerate` returns {configError: message}; any other
// failure (a tracked file gone from the work tree, unreadable) always throws.
// Callers pass a descriptor detectMode found in the work tree.
export function loadComponent(root, tracked, descriptorPath, tolerate) {
  try {
    return { component: readAntora(descriptorPath, readFileSync(join(root, descriptorPath), 'utf8'), tracked) };
  } catch (e) {
    if (!tolerate || !(e instanceof ConfigError)) throw e;
    return { configError: e.message };
  }
}

// Where a repo path sits in the component: its module, and its family and
// path within the family directory; module null when it is not under modules/.
function locate(path, component) {
  if (!path.startsWith(`${component.prefix}modules/`)) return { module: null, family: null, rel: null };
  const parts = path.slice(component.prefix.length).split('/');
  const family = FAMILY_OF_DIR[parts[2]] ?? null;
  return { module: parts[1], family, rel: family ? parts.slice(3).join('/') : null };
}

export function resolveXref(target, fromPath, component, defaultFamily = 'page') {
  if (!target || isExternal(target)) return null;
  // An absolute image target is served from the UI bundle or site root; Antora passes it through.
  if (defaultFamily === 'image' && target.startsWith('/')) return null;
  // Without .adoc, #, $, :, or @, `xref:id[]` names an anchor in this document.
  if (defaultFamily === 'page' && !/[#$:@]|\.adoc$/i.test(target)) return null;
  const id = decodeTarget(target.replace(/#.*$/, ''));
  if (!id) return null;
  let rest = id;
  let version = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    version = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const parts = rest.split(':');
  const last = parts.pop();
  if (parts.length > 2) return { unresolvable: `${target} is not an Antora resource ID`, invalid: true };
  const from = locate(fromPath, component);
  // parts is now [], [module], or [component, module]; an empty module name
  // means ROOT after a component (`guide::`) and the source's module otherwise.
  let name = null;
  let module;
  if (parts.length === 2) {
    name = parts[0];
    module = parts[1] || 'ROOT';
  } else if (parts.length === 1) {
    module = parts[0] || from.module || 'ROOT';
  } else {
    module = from.module || 'ROOT';
  }
  const dollar = last.indexOf('$');
  const family = dollar >= 0 ? last.slice(0, dollar) : defaultFamily;
  let path = dollar >= 0 ? last.slice(dollar + 1) : last;
  // With a fragment, an extensionless page target names the .adoc page.
  if (family === 'page' && target.includes('#') && !/\.adoc$/i.test(path)) path += '.adoc';
  const badName = (n) => n === '.' || n === '..' || /[/\\]/.test(n);
  if ((name !== null && badName(name)) || badName(module)) return { unresolvable: `${target}: invalid module or component name`, invalid: true };
  // An unversioned xref naming this component resolves against this checkout;
  // Antora would pick the latest version, which is the same for a
  // single-version repo (an approximation otherwise).
  if (name !== null && name !== component.name) return { unresolvable: `xref to component ${name}, which this repo does not hold` };
  if (version !== null && version !== component.version) return { unresolvable: `xref to version ${version}, which this checkout does not hold` };
  if (from.family === 'partial' && family === 'page') return { unresolvable: 'a page xref in a partial resolves against the page that includes it' };
  const dir = Object.hasOwn(FAMILY_DIRS, family) ? FAMILY_DIRS[family] : undefined;
  if (!dir) return { unresolvable: `unknown resource family ${family}$`, invalid: true };
  let rel = path;
  if (path.startsWith('./')) {
    if (from.family !== family || from.module !== module) return { unresolvable: `${target}: a ./ path needs a source file in the same family directory` };
    rel = posix.join(posix.dirname(from.rel), path);
  }
  rel = posix.normalize(rel);
  if (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return { unresolvable: `${target} leaves the ${dir} directory`, invalid: true };
  const out = `${component.prefix}modules/${module}/${dir}/${rel}`;
  if (posix.normalize(out) !== out || !out.startsWith(`${component.prefix}modules/`)) return { unresolvable: `${target} leaves the component's modules directory`, invalid: true };
  if (family === 'page' && unpublished(rel)) return { path: out, unpublished: `${target} names a page under a _ or . path segment, which Antora does not publish` };
  return { path: out };
}

export function resolveLink(target, fromPath, component) {
  if (!target || isExternal(target)) return null;
  if (target.startsWith('/')) return { unresolvable: `${target} is a site-absolute path` };
  const url = decodeTarget(target.replace(/[?#].*$/, '')).replace(/^\{attachmentsdir\}\//, '_attachments/');
  if (!url) return null;
  const from = locate(fromPath, component);
  if (from.family !== 'page') return { unresolvable: `${target}: a link: from outside pages/ cannot be mapped to a source file` };
  const base = `${component.prefix}modules/${from.module}`;
  const att = url.split('/').indexOf('_attachments');
  if (att >= 0) {
    const rel = posix.normalize(url.split('/').slice(att + 1).join('/'));
    if (rel === '.' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) return { unresolvable: `${target} leaves the attachments directory` };
    return { path: `${base}/attachments/${rel}` };
  }
  if (!/\.html$/i.test(url)) return { unresolvable: `${target}: a link: to a published file other than .html or _attachments/ cannot be mapped to a source file` };
  // Published URL space: ROOT pages sit at the component root, module M's
  // pages under M/. Resolve against the source page's published directory,
  // then map the result back to a module.
  const pubDir = from.module === 'ROOT' ? posix.dirname(from.rel) : posix.join(from.module, posix.dirname(from.rel));
  const pub = posix.normalize(posix.join(pubDir, url.replace(/\.html$/i, '.adoc')));
  if (pub === '..' || pub.startsWith('../') || posix.isAbsolute(pub)) return { unresolvable: `${target} leaves the component` };
  const segments = pub.split('/');
  const pageModules = new Set(component.pages.map((p) => p.slice(component.prefix.length).split('/')[1]));
  pageModules.delete('ROOT');
  if (segments.length < 2 || !pageModules.has(segments[0])) return { path: `${component.prefix}modules/ROOT/pages/${pub}` };
  // A ROOT directory named like a module publishes to the same URL prefix: Antora's choice between them is not decidable here.
  if (component.pages.some((p) => p.startsWith(`${component.prefix}modules/ROOT/pages/${segments[0]}/`))) return { unresolvable: `${target}: ${segments[0]}/ is both a module and a ROOT pages directory` };
  return { path: `${component.prefix}modules/${segments[0]}/pages/${segments.slice(1).join('/')}` };
}

export function readPlaybookUrl(path, text) {
  const site = loadSiteYaml(path, text).site;
  return site && typeof site === 'object' && typeof site.url === 'string' ? site.url : null;
}
