import tempfile
import unittest
from pathlib import Path

import test_support  # noqa: F401

from zhihu_cli.inputs import InputError, parse_reference, read_inputs


class InputTests(unittest.TestCase):
    def test_parses_answer_and_article(self):
        answer = parse_reference("https://zhihu.com/question/123/answer/456/?utm_source=test")
        article = parse_reference("https://zhuanlan.zhihu.com/p/789/?utm_source=test")
        self.assertEqual((answer.type, answer.id), ("answer", "456"))
        self.assertEqual((article.type, article.id), ("article", "789"))
        self.assertEqual(answer.question_id, "123")
        self.assertEqual(answer.url, "https://www.zhihu.com/question/123/answer/456")
        self.assertEqual(article.url, "https://zhuanlan.zhihu.com/p/789")

    def test_rejects_question_without_exact_answer(self):
        with self.assertRaises(InputError):
            parse_reference("https://www.zhihu.com/question/123")

    def test_rejects_other_hosts_and_numeric_ids(self):
        with self.assertRaises(InputError):
            parse_reference("https://example.com/question/1/answer/2")
        with self.assertRaises(InputError):
            parse_reference("123456")

    def test_batch_ignores_comments_and_deduplicates_by_type_and_id(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "urls.txt"
            path.write_text(
                "# comment\nhttps://www.zhihu.com/question/1/answer/2\n"
                "https://www.zhihu.com/question/1/answer/2/\n"
                "https://zhuanlan.zhihu.com/p/2\n",
                encoding="utf-8",
            )
            values = read_inputs(input_path=path)
        self.assertEqual([value.key for value in values], ["answer:2", "article:2"])


if __name__ == "__main__":
    unittest.main()
