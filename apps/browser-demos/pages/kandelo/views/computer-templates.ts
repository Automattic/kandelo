import type { GalleryItem } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { filesystemProfileId, type StoredComputer } from "../../../../../web-libs/kandelo-session/src/computer-library";

export interface ComputerTemplate {
  id: string;
  title: string;
  representative: GalleryItem;
  profiles: GalleryItem[];
}

export function computerTemplateFor(computer: StoredComputer, templates: readonly ComputerTemplate[]): ComputerTemplate | undefined {
  const source = computer.descriptor.mounts.find(mount => mount.path === "/" && mount.source === "image")?.ref;
  const exact = source ? templates.find(template => template.profiles.some(profile => profile.vfsImageUrl === source)) : undefined;
  const initialProfile = filesystemProfileId(computer) ?? computer.descriptor.id;
  return exact ?? templates.find(template => template.profiles.some(profile => profile.id === initialProfile));
}

export function computerTemplates(items: readonly GalleryItem[]): ComputerTemplate[] {
  const templates = new Map<string, ComputerTemplate>();
  for (const item of items) {
    const id = item.image?.id ?? item.vfsImageUrl ?? item.id;
    let template = templates.get(id);
    if (!template) {
      template = { id, title: item.image?.title ?? item.title, representative: item, profiles: [] };
      templates.set(id, template);
    }
    template.profiles.push(item);
    if (item.id === item.image?.defaultProfileId) template.representative = item;
  }
  return [...templates.values()];
}
