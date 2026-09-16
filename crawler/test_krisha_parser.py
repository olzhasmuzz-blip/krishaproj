import unittest

from crawler.krisha_parser import KrishaParser


SEARCH_HTML = '''
<html><body><div class="a-card"><a href="/a/show/123456789"><h3>2-комнатная квартира</h3><div class="a-card__price">42 000 000 ₸</div><div class="a-card__main-info">2-комн. · 58 м² · 5/9 этаж</div><div class="a-card__address">Алматы, Бостандыкский р-н</div></a></div></body></html>
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


if __name__ == "__main__":
    unittest.main()

