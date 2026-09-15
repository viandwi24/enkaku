import { describe, expect, test } from 'bun:test'
import { decodeCharRefs, parseUiDump } from './xml-parser'

describe('parseUiDump — character references in attributes', () => {
  test('a newline written as &#10; reads back as a newline (production SM-A075F #3, 2026-09-15)', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">' +
      '<node index="0" text="Simak sampai habis!&#10;&#10;#AkademiBitorex #fyp" resource-id="com.instagram.android:id/caption_input_text_view" class="android.widget.AutoCompleteTextView" package="com.instagram.android" content-desc="Baris&#xA;dua" clickable="true" enabled="true" focused="false" bounds="[30,751][690,841]" />' +
      '</hierarchy>'
    const field = parseUiDump(xml).children[0]
    expect(field?.text).toBe('Simak sampai habis!\n\n#AkademiBitorex #fyp')
    expect(field?.desc).toBe('Baris\ndua')
  })

  test('named entities still decode, and text without a reference is returned as it is', () => {
    const xml = '<?xml version="1.0"?><hierarchy><node text="Rock &amp; roll &quot;live&quot;" bounds="[0,0][1,1]" /></hierarchy>'
    expect(parseUiDump(xml).children[0]?.text).toBe('Rock & roll "live"')
    expect(decodeCharRefs('no references here')).toBe('no references here')
    expect(decodeCharRefs('emoji &#128512; and tab &#9;.')).toBe('emoji 😀 and tab \t.')
  })
})
