import sys
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from account_parser import (  # noqa: E402
    AccountInputError,
    extract_accounts_from_dom,
    extract_accounts_from_payload,
    parse_count,
    parse_profile_reference,
)


class AccountParserTests(unittest.TestCase):
    def test_parse_count_supports_douyin_units(self):
        self.assertEqual(parse_count("1.2万粉丝"), 12000)
        self.assertEqual(parse_count("2.5百万"), 2500000)
        self.assertEqual(parse_count("3,500"), 3500)
        self.assertEqual(parse_count("2.5K"), 2500)

    def test_profile_reference_rejects_search_and_other_hosts(self):
        parsed = parse_profile_reference("https://www.douyin.com/user/abc123")
        self.assertEqual(parsed["sec_uid"], "abc123")
        self.assertEqual(parse_profile_reference("abc123")["url"], parsed["url"])
        with self.assertRaises(AccountInputError):
            parse_profile_reference("https://www.douyin.com/search/财经?type=user")
        with self.assertRaises(AccountInputError):
            parse_profile_reference("https://example.com/user/abc123")

    def test_extract_nested_payload_preserves_raw_order(self):
        payload = {
            "user_list": [
                {"user_info": {"sec_uid": "one", "nickname": "甲", "follower_count": "2万"}},
                {"user_info": {"sec_uid": "one", "nickname": "甲", "follower_count": "2万"}},
                {"user_info": {"sec_uid": "two", "nickname": "乙", "follower_count": 300}},
            ]
        }
        accounts = extract_accounts_from_payload(payload)
        self.assertEqual([item["sec_uid"] for item in accounts], ["one", "one", "two"])
        self.assertEqual(accounts[0]["followers"], 20000)

    def test_extract_dom_user_links(self):
        markup = '<a href="/user/sec-one"><span>账号甲</span></a><a href="/user/sec-two">账号乙</a>'
        accounts = extract_accounts_from_dom(markup)
        self.assertEqual([item["sec_uid"] for item in accounts], ["sec-one", "sec-two"])
        self.assertEqual(accounts[0]["nickname"], "账号甲")

    def test_card_text_metrics_are_parsed(self):
        accounts = extract_accounts_from_payload([
            {
                "sec_uid": "sec-one",
                "nickname": "账号甲",
                "card_text": "账号甲 1.2万粉丝 3.4万获赞 56作品",
            }
        ])
        self.assertEqual(accounts[0]["followers"], 12000)
        self.assertEqual(accounts[0]["likes"], 34000)
        self.assertEqual(accounts[0]["post_count"], 56)

    def test_structured_search_fixture_does_not_join_douyin_id_and_likes(self):
        fixture = Path(__file__).parent / "fixtures" / "capital-search-card.json"
        accounts = extract_accounts_from_payload(json.loads(fixture.read_text(encoding="utf-8")))
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["nickname"], "资本论")
        self.assertEqual(accounts[0]["likes"], 110000000)
        self.assertEqual(accounts[0]["followers"], 8897000)


if __name__ == "__main__":
    unittest.main()
