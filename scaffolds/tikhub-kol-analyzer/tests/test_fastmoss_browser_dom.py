from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastmoss_pipeline.scraper import FastMossBlocked, FastMossScraper


class BrowserDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - setup.sh installs it
            raise unittest.SkipTest("Playwright is not installed") from exc
        cls.playwright_context = sync_playwright()
        cls.playwright = cls.playwright_context.__enter__()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.playwright_context.__exit__(None, None, None)

    def setUp(self) -> None:
        self.page = self.browser.new_page()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.scraper = FastMossScraper(Path(self.temp_dir.name) / "profile")

    def tearDown(self) -> None:
        self.page.close()
        self.temp_dir.cleanup()

    def test_extracts_rendered_creator_table(self) -> None:
        self.page.set_content("""
            <table>
              <thead><tr><th>Creator</th><th>Followers</th><th>GMV</th></tr></thead>
              <tbody><tr>
                <td><a href="https://www.tiktok.com/@demo.creator">@demo.creator</a></td>
                <td>8.2K</td><td>$12.5K</td>
              </tr></tbody>
            </table>
        """)
        rows = self.scraper._dom_records(self.page, "ES")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["username"], "demo.creator")
        self.assertEqual(rows[0]["followers"], 8_200)
        self.assertEqual(rows[0]["gmv"], 12_500)
        self.assertEqual(rows[0]["country"], "ES")

    def test_classifies_site_security_page(self) -> None:
        self.page.set_content("<main>Restricted Access: security policy blocked this request</main>")
        with self.assertRaises(FastMossBlocked):
            self.scraper._raise_if_blocked(self.page)

    def test_opens_phone_password_login_from_modal(self) -> None:
        self.page.set_content("""
            <button id="open-login">登录/注册</button>
            <div role="dialog" id="login-dialog" hidden>
              <button id="phone-login">手机号登录/注册</button>
              <section id="phone-panel" hidden>
                <button id="password-login">密码登录</button>
              </section>
              <form id="password-form" hidden>
                <input type="tel" placeholder="请输入手机号">
                <input type="password" placeholder="请输入密码">
                <button type="submit">登录</button>
              </form>
            </div>
            <script>
              document.querySelector('#open-login').onclick = () => {
                document.querySelector('#login-dialog').hidden = false;
              };
              document.querySelector('#phone-login').onclick = () => {
                document.querySelector('#phone-panel').hidden = false;
              };
              document.querySelector('#password-login').onclick = () => {
                document.querySelector('#password-form').hidden = false;
              };
            </script>
        """)

        self.scraper._open_login_form(self.page)

        password = self.page.locator('input[type="password"]')
        self.assertEqual(password.count(), 1)
        self.assertTrue(password.is_visible())

    def test_fills_ant_design_keyword_select(self) -> None:
        self.page.set_content("""
            <label>达人用户名或ID
              <div class="ant-select">
                <span class="ant-select-selection-search">
                  <input role="combobox" class="ant-select-selection-search-input"
                         placeholder="请输入达人用户名或ID">
                </span>
              </div>
            </label>
            <output id="selected"></output>
            <script>
              const input = document.querySelector('[role=combobox]');
              input.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                  document.querySelector('#selected').textContent = input.value;
                }
              });
            </script>
        """)

        self.assertTrue(self.scraper._fill_ant_select_keyword(self.page, "belleza"))
        self.assertEqual(self.page.locator("#selected").inner_text(), "belleza")

    def test_next_page_confirms_active_page_changed(self) -> None:
        self.page.set_content("""
            <ul class="ant-pagination">
              <li class="ant-pagination-item ant-pagination-item-active">1</li>
              <li class="ant-pagination-next"><button>Next</button></li>
            </ul>
            <script>
              document.querySelector('.ant-pagination-next button').onclick = () => {
                document.querySelector('.ant-pagination-item-active').textContent = '2';
              };
            </script>
        """)
        self.assertTrue(self.scraper._next_page(self.page))
        self.assertEqual(
            self.page.locator(".ant-pagination-item-active").inner_text(), "2"
        )

    def test_next_page_rejects_click_without_page_change(self) -> None:
        self.page.set_content("""
            <ul class="ant-pagination">
              <li class="ant-pagination-item ant-pagination-item-active">1</li>
              <li class="ant-pagination-next"><button>Next</button></li>
            </ul>
        """)
        self.scraper.timeout_ms = 100
        self.assertFalse(self.scraper._next_page(self.page))


if __name__ == "__main__":
    unittest.main()
