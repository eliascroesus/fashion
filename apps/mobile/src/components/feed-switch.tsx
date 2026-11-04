import { useTranslation } from 'react-i18next';
import type { FeedKind } from '../feed/keys';
import { SegmentedSwitch } from './segmented-switch';

/** The For You / Following switch at the top of Home. */
export function FeedSwitch({
  value,
  onChange,
}: {
  value: FeedKind;
  onChange: (kind: FeedKind) => void;
}) {
  const { t } = useTranslation();
  return (
    <SegmentedSwitch
      options={[
        { value: 'for-you', label: t('feed.forYou') },
        { value: 'following', label: t('feed.following') },
      ]}
      value={value}
      onChange={onChange}
      testIDPrefix="feed-switch"
    />
  );
}
