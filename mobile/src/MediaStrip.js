// The images and videos under one message in the agent chat. Tap an image for full screen (pinch to zoom);
// a video shows its first frame and length, comes over once it is ready on the computer, and plays here.
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMediaItem, useMediaOn, wantImage, wantVideo } from './media';
import { R, round, useTheme } from './theme';
import { Meta } from './ui';

const H = 132;
const time = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

// a demo item carries its own picture or clip (require'd asset); a real one is fetched by id
function useSource(ref, want = true) {
  const it = useMediaItem(ref.asset ? null : ref.id);
  useEffect(() => { if (!ref.asset && want && it?.state === 'idle') wantImage(ref.id); }, [ref.id, it?.state, want]);
  return ref.asset ? { state: 'ready', source: ref.asset } : { ...it, source: it?.uri ? { uri: it.uri } : null };
}

function Thumb({ item: r, onOpen }) {
  const t = useTheme();
  const s = useSource(r);
  const [ratio, setRatio] = useState(4 / 3);
  if (s.state === 'failed') return <View style={{ height: H, width: H * ratio, backgroundColor: t.wash, ...round(R.row), alignItems: 'center', justifyContent: 'center' }}><Meta>Image unavailable</Meta></View>;
  return (
    <Pressable onPress={() => s.source && onOpen(s.source)} style={{ height: H, width: H * ratio, backgroundColor: t.rule, ...round(R.row), overflow: 'hidden' }}>
      {s.source && <Image source={s.source} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={120}
        onLoad={(e) => e.source?.width && setRatio(Math.min(2.2, Math.max(0.5, e.source.width / e.source.height)))} />}
    </Pressable>
  );
}

function Player({ source }) {
  const player = useVideoPlayer(source, (p) => { p.loop = false; p.play(); });
  return <VideoView player={player} style={{ width: '100%', aspectRatio: 16 / 9 }} nativeControls allowsFullscreen contentFit="contain" />;
}

function Video({ item: r }) {
  const t = useTheme();
  const [playing, setPlaying] = useState(false);
  const it = useMediaItem(r.asset ? null : r.id);
  const poster = useSource(r.posterAsset ? { id: 'poster', asset: r.posterAsset } : r.poster ? { id: r.poster } : { id: null, asset: null }, !!r.poster);
  useEffect(() => { if (!r.asset && r.state === 'ready' && it?.state === 'idle') wantVideo(r); }, [r.id, r.state, it?.state]);
  const ready = r.asset || it?.state === 'ready';
  const note = r.state === 'failed' ? r.error || 'Could not make a phone copy'
    : r.state === 'converting' || r.state === 'new' ? 'Getting it ready on your computer…'
    : it?.state === 'loading' ? `On its way, ${it.n ? Math.round((100 * (it.got || 0)) / it.n) : 0}%`
    : it?.state === 'failed' ? 'Could not get this video' : null;
  return (
    <View style={{ width: '100%', backgroundColor: t.card, ...round(R.row), overflow: 'hidden' }}>
      {playing && ready ? <Player source={r.asset || { uri: it.uri }} /> : (
        <Pressable disabled={!ready} onPress={() => setPlaying(true)} style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: t.ink, alignItems: 'center', justifyContent: 'center' }}>
          {poster.source && <Image source={poster.source} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: ready ? 1 : 0.5 }} contentFit="cover" />}
          {ready && <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.sig, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ marginLeft: 4, width: 0, height: 0, borderTopWidth: 11, borderBottomWidth: 11, borderLeftWidth: 18, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: t.onInk || '#fff' }} />
          </View>}
        </Pressable>
      )}
      <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 10, paddingHorizontal: 12 }}>
        <Meta style={{ flex: 1 }} color={t.ink2} numberOfLines={1}>{r.name}</Meta>
        {note ? <Meta color={r.state === 'failed' || it?.state === 'failed' ? t.sig : t.ink3}>{note}</Meta>
          : <Meta>{r.cut ? `First ${time(r.cut)} of ${time(r.duration)}` : time(r.duration)}</Meta>}
      </View>
    </View>
  );
}

function Viewer({ source, onClose }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}>
          <Pressable onPress={onClose} style={{ flex: 1 }}>
            <Image source={source} style={{ flex: 1 }} contentFit="contain" />
          </Pressable>
        </ScrollView>
        <Pressable onPress={onClose} hitSlop={12} style={{ position: 'absolute', top: insets.top + 12, right: 20, padding: 8 }}>
          <Meta color="#fff" style={{ fontSize: 15 }}>Close</Meta>
        </Pressable>
      </View>
    </Modal>
  );
}

export function MediaStrip({ media }) {
  const on = useMediaOn();
  const [open, setOpen] = useState(null);
  if (!on || !media?.length) return null;
  // a gif the computer could not convert comes as an image
  const images = media.filter((r) => r.kind === 'image' || r.asImage), videos = media.filter((r) => r.kind === 'video' && !r.asImage);
  return (
    <View style={{ gap: 10 }}>
      {images.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {images.map((r) => <Thumb key={r.id} item={r} onOpen={setOpen} />)}
        </ScrollView>
      )}
      {videos.map((r) => <Video key={r.id} item={r} />)}
      {open && <Viewer source={open} onClose={() => setOpen(null)} />}
    </View>
  );
}
