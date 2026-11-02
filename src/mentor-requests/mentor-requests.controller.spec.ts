import { Test, TestingModule } from '@nestjs/testing';
import { MentorRequestsController } from './mentor-requests.controller.js';

describe('MentorRequestsController', () => {
  let controller: MentorRequestsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MentorRequestsController],
    }).compile();

    controller = module.get<MentorRequestsController>(MentorRequestsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
