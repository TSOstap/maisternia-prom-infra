// Рішення власника 06.11.2026: вимоги Google Merchant Center — опис ≤ 5 000 символів, без слів великими літерами.
import test from "node:test";
import assert from "node:assert/strict";
import { capsWords, fixCaps, descLength, plainText, GMC_MAX_DESC } from "../src/core/text-rules.mjs";

test("06.11: капс — фрази й заголовки → звичайний регістр; скорочення, бренди, коди моделей і латиниця — без змін", () => {
  assert.equal(fixCaps("<p><strong>НАПРУГА МЕРЕЖІ:</strong> 230 В</p>"), "<p><strong>Напруга мережі:</strong> 230 В</p>");
  assert.equal(fixCaps("<li>ХАРАКТЕРИСТИКА</li>"), "<li>Характеристика</li>");
  assert.equal(fixCaps("<p>Функція ФОРСАЖ ДУГИ допомагає. ГАРЯЧИЙ СТАРТ теж.</p>"), "<p>Функція форсаж дуги допомагає. Гарячий старт теж.</p>");
  assert.equal(fixCaps("<p>Для МДФ, ДСП, OSB; електроди АНО, УОНИ; ГОСТ і ДСТУ; бренд СЛОН і ПАТОН</p>"), "<p>Для МДФ, ДСП, OSB; електроди АНО, УОНИ; ГОСТ і ДСТУ; бренд СЛОН і ПАТОН</p>");
  assert.equal(fixCaps("<p>Модель ЕШМ-125, ТАOE-S, FELISATTI КМ-55, TA-MIG 200, МАКС 5 кВт</p>"), "<p>Модель ЕШМ-125, ТАOE-S, FELISATTI КМ-55, TA-MIG 200, макс 5 кВт</p>");
  assert.equal(fixCaps('<p style="font-size:16px">ОБ\'ЄМ БАКА</p>'), '<p style="font-size:16px">Об\'єм бака</p>');
  assert.equal(fixCaps("<p>&nbsp;КОМПЛЕКТАЦІЯ</p>"), "<p>&nbsp;Комплектація</p>");
  assert.equal(fixCaps("<p>Кнопка «ТЕСТ» і плита СИЛА 960500</p>"), "<p>Кнопка «ТЕСТ» і плита СИЛА 960500</p>", "напис у лапках і бренд — без змін");
  assert.deepEqual(capsWords("Модель СЛОН, ДСП, НАПРУГА 230 В, ЕШМ-125"), ["НАПРУГА"]);
  assert.deepEqual(capsWords(plainText(fixCaps("<p>НАПРУГА МЕРЕЖІ</p>"))), []);
});

test("06.11: довжина опису — текст без HTML і сутностей; межа 5 000", () => {
  assert.equal(GMC_MAX_DESC, 5000);
  assert.equal(descLength("<p>Привіт&nbsp;<strong>світ</strong></p>"), "Привіт світ".length);
  assert.equal(descLength("<p>a &laquo;b&raquo; &#39;c&#39;</p>"), "a «b» 'c'".length);
});
