import unittest

import test_support  # noqa: F401

from weibo_cli.parser import extract_count, parse_search_page, standardize_date


HTML = """
<html><body><ul class='s-scroll'><li>x</li><li>x</li></ul>
<div class='card-wrap' mid='123'>
 <div class='card'><div class='card-feed'><div class='content'><div class='info'><div></div><div><a href='/u/42' nick-name='测试用户'>测试用户</a></div></div>
 <p class='txt'>今天 这是正文 <a href='/n/t'>#话题#</a> <a href='/u/7'>@朋友</a></p>
 <div class='from'><a href='/u/42/AbC'>今天 12:00</a><a>iPhone</a></div>
 <a action-type='feed_list_forward'>1.2万</a><a action-type='feed_list_comment'>3</a><a action-type='feed_list_like'><button><span>赞</span><span>9</span></button></a>
 <div class='media media-piclist'><ul><li><img src='//wx1.sinaimg.cn/thumbnail/a.jpg'></li></ul></div>
 </div></div></div>
</div></body></html>
"""

MODERN_RETWEET_HTML = """
<html><body><div class='card-wrap' mid='9001'>
 <div class='info'><a href='/u/42' nick-name='转发者'>转发者</a></div>
 <p class='txt'>转发正文</p>
 <div class='from'><a href='/42/ParentBid'>今天 12:00</a></div>
 <div class='card-comment'>
  <a class='name' href='//weibo.com/u/77' nick-name='原作者'>原作者</a>
  <p class='txt' node-type='feed_list_content'>原微博正文</p>
  <a href='//weibo.com/77/OriginalBid?refer_flag=1'>08月14日 10:22</a>
 </div>
</div></body></html>
"""


class ParserTests(unittest.TestCase):
    def test_counts_and_relative_date(self):
        self.assertEqual(extract_count("1.2万"), 12000)
        self.assertEqual(standardize_date("2024-01-02 12:00"), "2024-01-02 12:00")

    def test_reference_card_fields(self):
        parsed = parse_search_page(HTML, query="测试", source_url="https://s.weibo.com/weibo?q=x")
        self.assertEqual(parsed["page_count"], 2)
        self.assertEqual(len(parsed["items"]), 1)
        item = parsed["items"][0]
        self.assertEqual(item["id"], "123")
        self.assertEqual(item["user_id"], "42")
        self.assertEqual(item["reposts_count"], 12000)
        self.assertTrue(item["pics"][0].startswith("https://"))

    def test_modern_retweet_is_saved_separately_and_linked(self):
        items = parse_search_page(MODERN_RETWEET_HTML, query="测试")["items"]
        self.assertEqual(len(items), 2)
        original, parent = items
        self.assertEqual(original["id"], "OriginalBid")
        self.assertEqual(original["user_id"], "77")
        self.assertEqual(parent["retweet_id"], "OriginalBid")


if __name__ == "__main__":
    unittest.main()
