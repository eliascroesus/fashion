import { useTranslation } from 'react-i18next';
import { PlaceholderScreen } from '../../components/placeholder-screen';

export default function CreateScreen() {
  const { t } = useTranslation();
  return (
    <PlaceholderScreen
      testID="screen-create"
      title={t('screens.create.title')}
      body={t('screens.create.comingSoon')}
    />
  );
}
