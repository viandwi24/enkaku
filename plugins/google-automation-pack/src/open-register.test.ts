import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/protocol'
import { classifyRegisterScreen, dominantPackage, findNodeByText } from './open-register'

function node(partial: Partial<UiNode>): UiNode {
  return {
    resourceId: '',
    text: '',
    desc: '',
    className: 'android.widget.TextView',
    packageName: 'com.google.android.googlequicksearchbox',
    bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
    ...partial,
  }
}

function screen(pkg: string, labels: string[]): UiNode {
  return node({
    packageName: pkg,
    className: 'android.widget.FrameLayout',
    children: labels.map((text, index) => node({ text, packageName: pkg, index })),
  })
}

describe('findNodeByText', () => {
  test('matches text, Indonesian first', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Telusuri', 'Tambahkan akun lain'])
    expect(findNodeByText(tree, /tambahkan akun lain|add another account/i)?.text).toBe('Tambahkan akun lain')
  })

  test('matches content descriptions too', () => {
    const tree = node({ children: [node({ desc: 'Add another account' })] })
    expect(findNodeByText(tree, /add another account/i)?.desc).toBe('Add another account')
  })

  test('returns null when nothing matches', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Telusuri', 'Beranda'])
    expect(findNodeByText(tree, /buat akun|create account/i)).toBeNull()
  })

  test('accepts a list of regexes and prefers the first that matches', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Telusuri', 'Login'])
    expect(findNodeByText(tree, [/^(login|masuk)$/i, /tambahkan akun/i])?.text).toBe('Login')
  })

  test('finds nodes nested deeper than one level', () => {
    const tree = node({ children: [node({ children: [node({ children: [node({ text: 'Buat akun' })] })] })] })
    expect(findNodeByText(tree, /buat akun/i)?.text).toBe('Buat akun')
  })
})

describe('classifyRegisterScreen', () => {
  test('a tree with the signup title is the register page', () => {
    const tree = screen('com.android.chrome', ['Buat Akun Google', 'Nama depan', 'Nama belakang'])
    expect(classifyRegisterScreen(tree).evidence).toBe('register-page')
  })

  test('the register page is also recognised by its name fields alone — the title is absent in some locales', () => {
    const tree = screen('com.android.chrome', ['First name', 'Last name', 'Create your account'])
    expect(classifyRegisterScreen(tree).evidence).toBe('register-page')
  })

  test('first-name without last-name is not enough', () => {
    const tree = screen('com.android.chrome', ['First name'])
    expect(classifyRegisterScreen(tree).evidence).toBe('other')
  })

  test('a chooser showing the create-account entry is `create-account-visible`', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Pilih akun', 'Buat akun'])
    expect(classifyRegisterScreen(tree).evidence).toBe('create-account-visible')
  })

  test('the account sheet with only an add-account row is `account-sheet`', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['farm.device07@gmail.com', 'Tambahkan akun lain'])
    expect(classifyRegisterScreen(tree).evidence).toBe('account-sheet')
  })

  test('the signed-out account sheet — first row "Login", measured on the farm — is `account-sheet`', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Login', 'Konten lainnya dari Google', 'Setelan'])
    expect(classifyRegisterScreen(tree).evidence).toBe('account-sheet')
  })

  test('the sign-in chooser is its own evidence, not the sheet', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Pilih akun', 'Gunakan akun lain'])
    expect(classifyRegisterScreen(tree).evidence).toBe('signin-chooser')
  })

  test('the audience chooser is its own evidence, even though "Buat akun" is still on it', () => {
    const tree = screen('com.google.android.gms', ['Buat akun', 'Untuk penggunaan pribadi saya', 'Untuk anak saya', 'Berikutnya'])
    expect(classifyRegisterScreen(tree).evidence).toBe('audience-chooser')
  })

  test('the home screen with its search box is `home`', () => {
    const tree = screen('com.google.android.googlequicksearchbox', ['Telusuri', 'Beranda'])
    expect(classifyRegisterScreen(tree).evidence).toBe('home')
  })

  test('a search box text inside another app is NOT home', () => {
    const tree = screen('com.android.chrome', ['Telusuri'])
    expect(classifyRegisterScreen(tree).evidence).toBe('other')
  })

  test('an unrecognised screen is `other`, never a made-up success', () => {
    const tree = screen('com.sec.android.app.camera', ['Foto', 'Video'])
    expect(classifyRegisterScreen(tree).evidence).toBe('other')
  })
})

describe('dominantPackage', () => {
  test('skips the empty root and the system UI to name the app actually on screen', () => {
    const tree = node({
      packageName: '',
      className: 'hierarchy',
      children: [
        node({ packageName: 'com.android.systemui', children: [node({ packageName: 'com.android.systemui' })] }),
        node({ packageName: 'com.google.android.googlequicksearchbox', children: [node({ packageName: 'com.google.android.googlequicksearchbox' })] }),
      ],
    })
    expect(dominantPackage(tree)).toBe('com.google.android.googlequicksearchbox')
  })

  test('falls back to the root package when no content package exists', () => {
    const tree = node({ packageName: '', children: [node({ packageName: 'com.android.systemui' })] })
    expect(dominantPackage(tree)).toBe('')
  })
})
