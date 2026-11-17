export const MAX_MENU_IMAGES = 10;

// An explicit empty gallery clears the legacy cover, while old dishes keep their photo.
export function menuImages(item) {
  const values = Array.isArray(item?.images) ? item.images : [item?.image];
  return [...new Set(values.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))].slice(0, MAX_MENU_IMAGES);
}
