// Paylaşım hedefi (POST, manifest share_target): uygulamanın service worker'ı henüz yoksa paylaşım buraya
// gelir; bağlantı adrese yazılıp uygulamaya yönlendirilir.
export default async (req) => {
    let link = '';
    try {
        const form = await req.formData();
        link = ['url', 'text', 'title'].map((k) => String(form.get(k) || ''))
            .map((v) => (v.match(/https?:\/\/\S+/) || [])[0]).find(Boolean) || '';
    } catch (_) { /* boş paylaşım */ }
    return new Response(null, { status: 303, headers: { location: link ? `/?text=${encodeURIComponent(link)}#detect` : '/#detect' } });
};
