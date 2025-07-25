import { ResourceFetcher } from '../../utils/ResourceFetcher';
import { ResourceSource } from '../../types/common';
import { ETError, getError } from '../../Error';
import { BaseNonStaticModule } from '../BaseNonStaticModule';

export class StyleTransferModule extends BaseNonStaticModule {
  async load(
    modelSource: ResourceSource,
    onDownloadProgressCallback: (_: number) => void = () => {}
  ): Promise<void> {
    const paths = await ResourceFetcher.fetch(
      onDownloadProgressCallback,
      modelSource
    );
    if (paths === null || paths.length < 1) {
      throw new Error('Download interrupted.');
    }
    this.nativeModule = global.loadStyleTransfer(paths[0] || '');
  }

  async forward(imageSource: string): Promise<string> {
    if (this.nativeModule == null)
      throw new Error(getError(ETError.ModuleNotLoaded));
    return await this.nativeModule.generate(imageSource);
  }
}
