# Фотографии карточек и иллюстрация бариста

Обновлено 19 сентября 2026. Изображения предоставлены заказчиком для сайта.

## Последняя замена: две чашки на первом экране

- Первый экран теперь использует `assets/hero-two-cups-720.webp` и
  `assets/hero-two-cups-1254.webp` (квадратные): источник — выбранный заказчиком
  локальный `hero-coffee-960.webp`, фактически 1254 × 1254, с двумя чашками и меню
  на деревянном столе. Прежний наклон одиночной кружки отключён. Часы работы
  сохранены в исходной светлой карточке поверх фото, по уточнению заказчика.
- «Сначала — кофе»: предоставленный `coffee-menu-1254.jpg` (853 × 1280)
  преобразован в `assets/coffee-soft-720.webp` (720 × 1080) и
  `assets/coffee-soft-853.webp` (853 × 1280). Исходное художественное размытие
  сохранено, фото не перерисовано. Кадрирование `50% 78%` соответствует присланному
  примеру: обе чашки крупные, с небольшим запасом снизу.
- Для портретной карточки ограничен базовый параллакс до 12 px: движение
  не обрезает чашки. Новые WebP экспортированы с качеством 92, без увеличения
  разрешения и без EXIF/IPTC/XMP. Имена изменены для обхода старого кэша.
- Локальные пользовательские варианты `hero-coffee-9601.webp` и
  `hero-coffee-96011.webp`, а также изменения/удаления старых файлов не включены
  в эту публикацию. Ниже сохранена история прежних вариантов и AI-обработки.

## Файлы и обработка

| Назначение | Источник | Веб-версии |
| --- | --- | --- |
| Первый экран «Территория утра» | Предоставленный `IMG_4383.JPG`, 4160 × 6240; оригинал оставлен в папке загрузок | `assets/hero-coffee-960.webp`, `assets/hero-coffee-1600.webp` |
| «Сначала — кофе» | `assets/coffee-menu-original.jpg` → `assets/coffee-menu-expanded.png` (1254 × 1254) | `assets/coffee-menu-720.webp`, `assets/coffee-menu-1254.webp` |
| «Потом — завтрак» | `assets/breakfast-plate-original.jpg` (1280 × 853) → `assets/breakfast-wide.png` (1254 × 1254) | `assets/breakfast-wide-720.webp`, `assets/breakfast-wide-1254.webp` |
| «И что-нибудь к чаю» | `assets/syrniki-original.jpg` (1280 × 853) → `assets/syrniki-wide.png` (1254 × 1254) | `assets/syrniki-wide-720.webp`, `assets/syrniki-wide-1254.webp` |
| «Можно просто быть собой» | Имеющийся `assets/cafe-barista.png` (972 × 1280) | `assets/cafe-barista-large-640.webp`, `assets/cafe-barista-large-972.webp` |

Фотография кофе расширена встроенным ImageGen (не CLI/API): дорисовано окружение
для более свободного кадрирования и запаса вокруг надписи при параллаксе.
Это AI-обработка предоставленного фото, не неизменённый оригинал; исходник сохранён
для сравнения. Мелкий текст меню на обработанном фото не является источником
актуальных цен или ассортимента. Фото завтрака и сырников также расширены
встроенным ImageGen в режиме редактирования: добавлено пространство вокруг
тарелок, чтобы блюда воспринимались более общим планом. Это сгенерированные
версии фотографий, не пиксельно идентичные оригиналам. Оригиналы сохранены
для сравнения. Иллюстрация бариста и новый кофе первого экрана не перерисованы.

WebP экспортированы через Sharp с `quality: 92` (первый экран — 91), `effort: 6`, `withoutEnlargement: true`.
Два размера подключены через `srcset`/`sizes`; новые версии не содержат EXIF/IPTC/XMP.
Исходные фото карточек также проверены: этих метаданных в них нет. Новый исходник
первого экрана содержит EXIF и не опубликован; веб-версии очищены от метаданных,
не перерисованы и загружаются приоритетно с согласованным responsive preload.
Наклон оси кружки исправлен в оформлении: статичный поворот на 2° по часовой
стрелке и масштаб 1,08 скрывают углы фотографии после поворота. Сам файл
не изменён; параллакс первого экрана по-прежнему отключён.
Декоративное расширение
не выдаётся за увеличение детализации исходного снимка.

У кофе фокус кадра — `50% 25%`: это сохраняет надпись на широком мобильном экране.
Проверяется положение надписи при полностью видимой карточке, включая движение
при прокрутке и отключённые анимации. Завтрак и сырники центрированы; их
Статичное `scale: 1.4` приближает обе тарелки на 40% относительно расширенных
кадров — по повторному уточнению заказчика; это ещё примерно на 17% крупнее
промежуточного варианта `1.2`. Края тарелок частично уходят за рамку,
акцент остаётся на блюдах. Масштаб не анимируется и не влияет на скорость прокрутки.
`data-depth-framing="full"` ограничивает базовый ход до 12 пикселей перед
коэффициентом профиля (итог: 7,8 и 13,44 пикселя). Это уменьшает увеличение
для запаса параллакса. На мобильном высота карточек растёт вместе с шириной
экрана (`clamp(310px, 80vw, 480px)`), сохраняя более полный кадр.
В секции о кофейне теперь одна иллюстрация,
без наложенной миниатюры и без прежних отступов под неё. Старые исходники оставлены
для возможности возврата, но фотография с девушками больше не подключается.

## Промпты встроенного ImageGen

### 4. Более общий план завтрака

Use case: precise-object-edit. Image 1 is the EDIT TARGET, a real cafe breakfast photograph. Reframe by expanding the canvas, not by redesigning the food. Make a square photo showing the SAME complete plate further away, centred, with ample natural pale tabletop around it. The entire blue-rimmed irregular white platter should occupy approximately 70 percent of the square width and 55 percent of its height, centered vertically, with the whole dish visible. Extend the clipped edges of the existing plate, bread and tabletop naturally. Keep exactly the original arrangement, camera angle, realistic lighting, ingredient quantities, four egg halves, toast, salmon, folded ham, avocado, ricotta, tomatoes, rocket and seeds. Do not add any ingredients, garnish, cutlery, napkins or extra objects. Preserve real food textures, natural color and the plate's blue rim; avoid plastic or oversharpened rendering. This is for a website photo card with subtle scroll motion, so leave clean margin around the complete dish on all four sides; do not crop the food. Output only the finished square wider-framed photograph, ideally 1536 x 1536.

### 5. Более общий план сырников

Use case: precise-object-edit. Image 1 is the EDIT TARGET, a real cafe photograph of syrniki. Reframe by expanding the canvas, not by redesigning or replacing the dish. Output a square photograph showing the SAME complete white plate from farther away, centered, with soft natural pale tabletop around it. The complete plate should fit inside the central approximately 70 percent of the image width with generous breathing room above and below. Preserve exactly the three existing golden syrniki, their size relationships and arrangement, the creamy poppy-seed sauce, strawberry pieces, blueberries, almond flakes, mint leaves, original camera angle, light and natural color. Extend only the clipped plate edge and matching tabletop naturally; do not add cakes, berries, garnish, cutlery, cloth, logos, text or new props. Keep the source's authentic photographic softness and depth of field, not a stylized food render. For a website menu card: the whole portion and plate should be understandable at a glance, with room around the dish rather than a macro crop. Return just the finished wider-framed square photo, ideally 1536 x 1536.

Ниже сохранена история предыдущей подготовки фотографии кофе с меню.

### 1. Расширение исходной фотографии

Use case: precise-object-edit. Asset type: photograph for a cafe website menu card. Image 1 is the EDIT TARGET, not a style reference. Expand/outpaint this exact photograph gently to a square composition, approximately 1536 x 1536. Keep the original photograph in the centre at the same relative geometry; extend the existing dark natural wooden tabletop at the left and right, and a little above if necessary. This is a framing extension, NOT a new recreation of the cups or menus. Preserve exactly both ceramic coffee mugs, all latte art and cinnamon, handles, their positions, the cream menu with blue outline and breakfast drawing, and the blue menu/folder behind it, original lighting, colors, shadows and detailed texture. Make sure the cream menu's complete Cyrillic brand title "восемь утра" and the two cups remain inside a generous safe area, visible even when the square image is displayed at a slightly wider 1.1:1 crop. Preserve the brand lettering shape and exact spelling; preserve all existing printed text, do not invent any new menu wording or prices. Add only matching wooden tabletop in the new margins and seamless continuation of existing edge-truncated objects if required. Photorealistic, natural photography, crisp but not oversharpened, no blur, no filters, no borders, no extra objects, no watermarks. Return only the finished extended photograph.

### 2. Дополнительный запас сверху для карточки с движением

Use case: precise-object-edit. Image 1 is the edit target: the already extended cafe photograph. Make ONE framing adjustment only, by outpainting additional matching wooden tabletop. Extend the square canvas upward by about 280 pixels, downward by about 65 pixels, and equally on the left and right to keep the final canvas square (think original 1254 x 1254 intact inside a new 1600 x 1600 canvas, original top-left at approximately x173 y280). Scale the resulting whole image to the output resolution if needed. This adds breathing room ABOVE the menus for a website card with subtle vertical scroll motion. Preserve the exact existing cups, foam, blue folder, cream menu, typography, colors and original pixels as faithfully as possible. Do NOT move, rotate, reshape or redraw the subjects independently. The highest part of the main Cyrillic brand wordmark "восемь утра" should now be about 26 percent down from the final image top; do not put new lettering into the new margins. Only extend naturally existing wood and the blue menu edge if needed. Keep original main wordmark exactly, crisp and legible. Natural realistic tabletop grain, continuous lighting, no new props, no text overlays, no artificial blur, no border or vignette. Return the final square expanded photograph only.

### 3. Удаление лишней черты после названия

Use case: precise-object-edit. Image 1 is the edit target. Make a tiny local correction ONLY: remove the short thin dark horizontal dash immediately following the final letter of the large Cyrillic brand title on the cream menu. The title must read exactly "восемь утра", with NO trailing dash, punctuation or added marks. Fill only that dash area with matching cream paper. Preserve absolutely everything else in the image: the existing wordmark letters, all other menu text, paper borders, both cups, foam art, their shapes and positions, entire expanded framing, wood grain, lighting and colors. Do not zoom, crop, rearrange, recompose, redraw or enhance the rest of the photograph. Return the same square image with only the stray dash removed.
