/**
 * The page scrollbar lives in the right page margin. The boards were drawn on a 1440 window with no scrollbar; a real
 * window loses 12 px to it, which squeezed every 18-column grid (five 204 cards beside the Library's rail, six on Discover).
 * So the page's right margin gives the scrollbar its width back: ahoy.css pads the right side with
 * --page-r = --page-x − --sb, and this keeps --sb (the scrollbar's width, 0 when the page does not scroll) on the root.
 * At a 1440 window the content is the boards' 1344 again, and the scrollbar sits in the 48 px margin.
 */
export function watchScrollbar() {
  const root = document.documentElement;
  let frame = 0;
  const measure = () => {
    frame = 0;
    const sb = Math.max(0, window.innerWidth - root.clientWidth);
    const v = `${sb}px`;
    if (root.style.getPropertyValue("--sb") !== v) root.style.setProperty("--sb", v);
  };
  // after layout settles (a scrollbar that appears changes the body's size; measuring in the same frame would loop)
  const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
  measure();
  new ResizeObserver(later).observe(document.body);
  addEventListener("resize", later);
}
