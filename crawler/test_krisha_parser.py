import unittest

from crawler.krisha_parser import KrishaParser


SEARCH_HTML = '''
<html><body><div class="a-card"><a href="/a/show/123456789"><h3>2-комнатная квартира</h3><div class="a-card__price">42 000 000 ₸</div><div class="a-card__main-info">2-комн. · 58 м² · 5/9 этаж</div><div class="a-card__address">Алматы, Бостандыкский р-н</div></a></div></body></html>
'''

KRISHA_CARD_HTML = '''
<html><body><div class="a-card a-storage-live" data-id="987654321">
  <a class="a-card__image" href="/a/show/987654321" title="Продажа квартиры">
    <picture data-full-src="https://photos.example/full.jpg"><source srcset="https://photos.example/card.webp 1x"><img src="https://photos.example/card.jpg"></picture>
  </a>
  <div class="a-card__header"><a class="a-card__title" href="/a/show/987654321">3-комнатная квартира · 82 м² · 6/12 этаж</a>
    <div class="a-card__price">67 500 000 ₸</div></div>
  <div class="a-card__subtitle">Бостандыкский р-н, пр. Абая</div>
  <div class="a-card__text-preview">Монолитный дом, свежий ремонт, рядом парк.</div>
  <div class="a-card__owner-label">Хозяин недвижимости</div>
  <div class="a-card__stats-item">Алматы</div>
</div></body></html>
'''


class KrishaParserTest(unittest.TestCase):
    def test_search_page_extracts_listing_fields(self):
        parser = KrishaParser(min_interval_s=0)
        items = parser.parse_search_page(SEARCH_HTML, page_url="https://krisha.kz/prodazha/kvartiry/almaty/")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].source_id, "123456789")
        self.assertEqual(items[0].price_kzt, 42_000_000)
        self.assertEqual(items[0].area_m2, 58.0)
        self.assertEqual(items[0].floor, 5)
        self.assertEqual(items[0].floors_total, 9)

    def test_live_krisha_card_extracts_structured_fields_not_whole_card_as_title(self):
        parser = KrishaParser(min_interval_s=0)
        items = parser.parse_search_page(KRISHA_CARD_HTML, page_url="https://krisha.kz/prodazha/kvartiry/almaty/")
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item.title, "3-комнатная квартира · 82 м² · 6/12 этаж")
        self.assertEqual(item.price_kzt, 67_500_000)
        self.assertEqual(item.rooms, 3)
        self.assertEqual(item.area_m2, 82.0)
        self.assertEqual((item.floor, item.floors_total), (6, 12))
        self.assertEqual(item.city, "Алматы")
        self.assertEqual(item.district, "Бостандыкский р-н")
        self.assertIn("свежий ремонт", item.description)
        self.assertIn("https://photos.example/full.jpg", item.photo_urls)

    def test_search_ignores_listing_links_outside_result_cards(self):
        html = '''
        <html><body>
          <section class="a-list a-search-list">
            <div class="a-card a-storage-live" data-id="123456789">
              <a class="a-card__title" href="/a/show/123456789">2-комнатная квартира · 58 м²</a>
              <div class="a-card__price">42 000 000 ₸</div>
            </div>
          </section>
          <aside class="recommendations">
            <div class="a-card a-storage-live" data-id="987654321">
              <a href="/a/show/987654321">Рекомендованное объявление · 3-комнатная</a>
            </div>
          </aside>
        </body></html>
        '''
        parser = KrishaParser(min_interval_s=0)
        items = parser.parse_search_page(html, page_url="https://krisha.kz/prodazha/kvartiry/almaty/")
        self.assertEqual([item.source_id for item in items], ["123456789"])


if __name__ == "__main__":
    unittest.main()

