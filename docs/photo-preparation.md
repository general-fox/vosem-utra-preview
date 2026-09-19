# Фотографии карточек и иллюстрация бариста

Обновлено 19 сентября 2026. Изображения предоставлены заказчиком для сайта.

## Файлы и обработка

| Назначение | Источник | Веб-версии |
| --- | --- | --- |
| «Сначала — кофе» | `assets/coffee-menu-original.jpg` → `assets/coffee-menu-expanded.png` (1254 × 1254) | `assets/coffee-menu-720.webp`, `assets/coffee-menu-1254.webp` |
| «Потом — завтрак» | `assets/syrniki-original.jpg` (1280 × 853) | `assets/syrniki-800.webp`, `assets/syrniki-1280.webp` |
| «Можно просто быть собой» | Имеющийся `assets/cafe-barista.png` (972 × 1280) | `assets/cafe-barista-large-640.webp`, `assets/cafe-barista-large-972.webp` |

Фотография кофе расширена встроенным ImageGen (не CLI/API): дорисовано окружение
для более свободного кадрирования и запаса вокруг надписи при параллаксе.
Это AI-обработка предоставленного фото, не неизменённый оригинал; исходник сохранён
для сравнения. Мелкий текст меню на обработанном фото не является источником
актуальных цен или ассортимента. Фото сырников и иллюстрация бариста не перерисованы.

WebP экспортированы через Sharp с `quality: 92`, `effort: 6`, `withoutEnlargement: true`.
Два размера подключены через `srcset`/`sizes`; новые версии не содержат EXIF/IPTC/XMP.
Исходные фото также проверены: этих метаданных в них нет. Декоративное расширение
не выдаётся за увеличение детализации исходного снимка.

У кофе фокус кадра — `50% 25%`: это сохраняет надпись на широком мобильном экране.
Проверяется положение надписи при полностью видимой карточке, включая движение
при прокрутке и отключённые анимации. В секции о кофейне теперь одна иллюстрация,
без наложенной миниатюры и без прежних отступов под неё. Старые исходники оставлены
для возможности возврата, но фотография с девушками больше не подключается.

## Промпты встроенного ImageGen

### 1. Расширение исходной фотографии

Use case: precise-object-edit. Asset type: photograph for a cafe website menu card. Image 1 is the EDIT TARGET, not a style reference. Expand/outpaint this exact photograph gently to a square composition, approximately 1536 x 1536. Keep the original photograph in the centre at the same relative geometry; extend the existing dark natural wooden tabletop at the left and right, and a little above if necessary. This is a framing extension, NOT a new recreation of the cups or menus. Preserve exactly both ceramic coffee mugs, all latte art and cinnamon, handles, their positions, the cream menu with blue outline and breakfast drawing, and the blue menu/folder behind it, original lighting, colors, shadows and detailed texture. Make sure the cream menu's complete Cyrillic brand title "восемь утра" and the two cups remain inside a generous safe area, visible even when the square image is displayed at a slightly wider 1.1:1 crop. Preserve the brand lettering shape and exact spelling; preserve all existing printed text, do not invent any new menu wording or prices. Add only matching wooden tabletop in the new margins and seamless continuation of existing edge-truncated objects if required. Photorealistic, natural photography, crisp but not oversharpened, no blur, no filters, no borders, no extra objects, no watermarks. Return only the finished extended photograph.

### 2. Дополнительный запас сверху для карточки с движением

Use case: precise-object-edit. Image 1 is the edit target: the already extended cafe photograph. Make ONE framing adjustment only, by outpainting additional matching wooden tabletop. Extend the square canvas upward by about 280 pixels, downward by about 65 pixels, and equally on the left and right to keep the final canvas square (think original 1254 x 1254 intact inside a new 1600 x 1600 canvas, original top-left at approximately x173 y280). Scale the resulting whole image to the output resolution if needed. This adds breathing room ABOVE the menus for a website card with subtle vertical scroll motion. Preserve the exact existing cups, foam, blue folder, cream menu, typography, colors and original pixels as faithfully as possible. Do NOT move, rotate, reshape or redraw the subjects independently. The highest part of the main Cyrillic brand wordmark "восемь утра" should now be about 26 percent down from the final image top; do not put new lettering into the new margins. Only extend naturally existing wood and the blue menu edge if needed. Keep original main wordmark exactly, crisp and legible. Natural realistic tabletop grain, continuous lighting, no new props, no text overlays, no artificial blur, no border or vignette. Return the final square expanded photograph only.

### 3. Удаление лишней черты после названия

Use case: precise-object-edit. Image 1 is the edit target. Make a tiny local correction ONLY: remove the short thin dark horizontal dash immediately following the final letter of the large Cyrillic brand title on the cream menu. The title must read exactly "восемь утра", with NO trailing dash, punctuation or added marks. Fill only that dash area with matching cream paper. Preserve absolutely everything else in the image: the existing wordmark letters, all other menu text, paper borders, both cups, foam art, their shapes and positions, entire expanded framing, wood grain, lighting and colors. Do not zoom, crop, rearrange, recompose, redraw or enhance the rest of the photograph. Return the same square image with only the stray dash removed.
